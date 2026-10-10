import * as vscode from "vscode";
import { spawn } from "child_process";
import { OllamaClient } from "../ollama/client";
import { loadConfig } from "../config";

const STATE_KEY = "ollamacode.onboard.done";

/** Curated starter models for a fresh Ollama install (small → useful). */
export const STARTER_MODELS: Array<{
  id: string;
  label: string;
  description: string;
  detail?: string;
}> = [
  {
    id: "qwen2.5-coder:7b",
    label: "Qwen2.5 Coder 7B",
    description: "код · tools · хороший старт",
    detail: "~4.7 GB",
  },
  {
    id: "llama3.2:3b",
    label: "Llama 3.2 3B",
    description: "лёгкая · быстрая",
    detail: "~2 GB",
  },
  {
    id: "qwen3:8b",
    label: "Qwen3 8B",
    description: "thinking · tools",
    detail: "~5 GB",
  },
  {
    id: "mistral:7b",
    label: "Mistral 7B",
    description: "универсальная",
    detail: "~4 GB",
  },
  {
    id: "gemma3:4b",
    label: "Gemma 3 4B",
    description: "компактная Google",
    detail: "~3 GB",
  },
];

export type OllamaProbe =
  | { ok: true; models: string[]; baseUrl: string }
  | { ok: false; reason: "unreachable" | "no_models"; baseUrl: string; message: string };

export async function probeOllama(): Promise<OllamaProbe> {
  const cfg = loadConfig();
  const client = new OllamaClient(cfg.ollama.baseUrl);
  try {
    const models = await client.listModels();
    if (!models.length) {
      return {
        ok: false,
        reason: "no_models",
        baseUrl: cfg.ollama.baseUrl,
        message: "Ollama запущена, но моделей ещё нет",
      };
    }
    return {
      ok: true,
      models: models.map((m) => m.name),
      baseUrl: cfg.ollama.baseUrl,
    };
  } catch (e: any) {
    return {
      ok: false,
      reason: "unreachable",
      baseUrl: cfg.ollama.baseUrl,
      message: String(e?.message || e),
    };
  }
}

export async function openOllamaDownloadPage(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse("https://ollama.com/download"));
}

/** Try winget install on Windows; otherwise open the download page. */
export async function installOllamaViaWingetOrBrowser(): Promise<"winget" | "browser"> {
  if (process.platform === "win32") {
    const channel = vscode.window.createOutputChannel("OllamaCode Setup");
    channel.show(true);
    channel.appendLine("winget install Ollama.Ollama …");
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(
        "winget",
        ["install", "-e", "--id", "Ollama.Ollama", "--accept-package-agreements", "--accept-source-agreements"],
        { shell: true, env: process.env, windowsHide: true }
      );
      child.stdout.on("data", (d) => channel.append(d.toString()));
      child.stderr.on("data", (d) => channel.append(d.toString()));
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
    if (ok) {
      void vscode.window.showInformationMessage(
        "Ollama установлена. Запусти Ollama (иконка в трее), затем Refresh Models."
      );
      return "winget";
    }
  }
  await openOllamaDownloadPage();
  void vscode.window.showInformationMessage(
    "Открыта страница загрузки Ollama. Установи, запусти приложение, затем выбери модели."
  );
  return "browser";
}

export async function pullOllamaModel(
  tag: string,
  onRefresh?: () => void
): Promise<boolean> {
  const channel = vscode.window.createOutputChannel("OllamaCode Pull");
  channel.show(true);
  channel.appendLine(`ollama pull ${tag}`);
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `ollama pull ${tag}`,
        cancellable: false,
      },
      async () => {
        await new Promise<void>((resolve, reject) => {
          const child = spawn("ollama", ["pull", tag], {
            shell: true,
            env: process.env,
            windowsHide: true,
          });
          child.stdout.on("data", (d) => channel.append(d.toString()));
          child.stderr.on("data", (d) => channel.append(d.toString()));
          child.on("error", (e) => reject(e));
          child.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`exit ${code}`))
          );
        });
      }
    );
    onRefresh?.();
    void vscode.window.showInformationMessage(`Модель готова: ${tag}`);
    return true;
  } catch (e: any) {
    void vscode.window.showErrorMessage(`Не удалось скачать ${tag}: ${e?.message || e}`);
    return false;
  }
}

export async function pickAndPullStarterModels(onRefresh?: () => void): Promise<void> {
  const picks = await vscode.window.showQuickPick(
    STARTER_MODELS.map((m) => ({
      label: m.label,
      description: m.description,
      detail: `${m.id}${m.detail ? ` · ${m.detail}` : ""}`,
      id: m.id,
      picked: m.id.startsWith("qwen2.5-coder"),
    })),
    {
      title: "OllamaCode — выбрать модели",
      placeHolder: "Можно выбрать несколько · скачаются через ollama pull",
      canPickMany: true,
      ignoreFocusOut: true,
    }
  );
  if (!picks?.length) return;
  for (const p of picks) {
    await pullOllamaModel(p.id, onRefresh);
  }
}

/**
 * First-run / empty-stack wizard. Safe to call often — only prompts when Ollama
 * is missing or has zero models, and at most once per "needs help" state unless force.
 */
export async function runOllamaOnboarding(
  context: vscode.ExtensionContext,
  opts?: { force?: boolean; onRefresh?: () => void }
): Promise<void> {
  const probe = await probeOllama();
  if (probe.ok) {
    await context.globalState.update(STATE_KEY, true);
    return;
  }

  if (!opts?.force && context.globalState.get<boolean>(STATE_KEY) && probe.reason === "unreachable") {
    // Already dismissed once while Ollama was down — don't spam every reload.
    // Still allow manageModels / force.
    return;
  }

  if (probe.reason === "unreachable") {
    const choice = await vscode.window.showWarningMessage(
      `Ollama не найдена (${probe.baseUrl}). Установи локальный рантайм, чтобы выбирать модели в Agent.`,
      { modal: false },
      "Установить Ollama",
      "Открыть сайт",
      "Позже"
    );
    if (choice === "Установить Ollama") {
      await installOllamaViaWingetOrBrowser();
      await pickAndPullStarterModels(opts?.onRefresh);
    } else if (choice === "Открыть сайт") {
      await openOllamaDownloadPage();
    }
    await context.globalState.update(STATE_KEY, true);
    return;
  }

  // Ollama up, zero models
  const choice = await vscode.window.showInformationMessage(
    "Ollama запущена, но моделей нет. Выбери модели для скачивания.",
    "Выбрать модели",
    "Hugging Face…",
    "Позже"
  );
  if (choice === "Выбрать модели") {
    await pickAndPullStarterModels(opts?.onRefresh);
  } else if (choice === "Hugging Face…") {
    await vscode.commands.executeCommand("ollamaCode.pullHfModel");
  }
  await context.globalState.update(STATE_KEY, true);
}

/** Entries for manageModels QuickPick when Ollama is missing / empty. */
export function setupQuickPickItems(probe: OllamaProbe): vscode.QuickPickItem[] {
  if (probe.ok) return [];
  if (probe.reason === "unreachable") {
    return [
      {
        label: "$(desktop-download) Установить Ollama",
        description: "winget / сайт ollama.com",
        detail: probe.message,
      },
      {
        label: "$(link-external) Открыть ollama.com/download",
        description: "официальный установщик",
      },
    ];
  }
  return [
    {
      label: "$(cloud-download) Выбрать стартовые модели",
      description: "qwen / llama / mistral / gemma",
      detail: probe.message,
    },
  ];
}
