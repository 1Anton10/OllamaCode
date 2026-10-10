import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { loadConfig } from "../config";

export function ollamaCodeConfigDir(): string {
  return path.join(os.homedir(), ".ollamacode");
}

export function apiModelsConfigPath(): string {
  return path.join(ollamaCodeConfigDir(), "chatLanguageModels.json");
}

export async function ensureApiModelsTemplate(
  extensionRoot?: string
): Promise<string> {
  const dir = ollamaCodeConfigDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const target = apiModelsConfigPath();
  if (!fs.existsSync(target)) {
    const candidates = [
      extensionRoot
        ? path.join(extensionRoot, "..", "..", "config", "chatLanguageModels.example.json")
        : "",
      vscode.workspace.workspaceFolders?.[0]
        ? path.join(
            vscode.workspace.workspaceFolders[0].uri.fsPath,
            "config",
            "chatLanguageModels.example.json"
          )
        : "",
    ].filter(Boolean);
    const example = candidates.find((p) => fs.existsSync(p));
    if (example) {
      fs.copyFileSync(example, target);
    } else {
      fs.writeFileSync(target, JSON.stringify({ providers: {} }, null, 2), "utf8");
    }
  }
  return target;
}

async function tryUpdate(section: string, key: string, value: unknown): Promise<void> {
  try {
    await vscode.workspace
      .getConfiguration(section)
      .update(key, value, vscode.ConfigurationTarget.Global);
  } catch (e: any) {
    console.warn(`OllamaCode skip setting ${section}.${key}:`, e?.message || e);
  }
}

/**
 * Force Ollama-only Agent/Models/BYOK chat. Copilot surfaces stay disabled.
 * Avoid rewriting settings on every activate — that races chat model selection.
 */
export async function applyOllamaOnlyPolicy(force = false): Promise<void> {
  const cfg = loadConfig();
  const utility = { vendor: "ollamacode", id: cfg.ollama.defaultModel };
  const chat = vscode.workspace.getConfiguration("chat");

  const byok = chat.get("byokUtilityModelDefault");
  if (force || byok !== "mainAgent") {
    await tryUpdate("chat", "byokUtilityModelDefault", "mainAgent");
  }
  const util = chat.get<{ vendor?: string; id?: string }>("utilityModel");
  if (force || util?.vendor !== "ollamacode" || util?.id !== cfg.ollama.defaultModel) {
    await tryUpdate("chat", "utilityModel", utility);
  }
  const utilSmall = chat.get<{ vendor?: string; id?: string }>("utilitySmallModel");
  if (force || utilSmall?.vendor !== "ollamacode") {
    await tryUpdate("chat", "utilitySmallModel", utility);
  }
  if (force || chat.get("agent.enabled") !== true) {
    await tryUpdate("chat", "agent.enabled", true);
  }
  // Hide stock Copilot CLI terminal ghost-hint for all profiles
  await tryUpdate("terminal", "integrated.initialHint", false);
  // Do NOT touch unifiedChatView / setupFromDialog — not registered on OSS 1.140

  for (const id of ["GitHub.copilot", "GitHub.copilot-chat", "GitHub.copilot-nightly"]) {
    try {
      const ext = vscode.extensions.getExtension(id);
      if (ext) {
        await vscode.commands.executeCommand("workbench.extensions.disableExtension", id);
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * Open native VS Code Agent chat (Models + BYOK Ollama) — never Copilot Ask.
 */
export async function openOllamaAgentChat(): Promise<void> {
  try {
    await tryUpdate("chat", "agent.enabled", true);
  } catch {
    /* ignore */
  }

  const attempts: Array<() => Thenable<unknown>> = [
    () =>
      vscode.commands.executeCommand("workbench.action.chat.open", {
        query: "",
        isPartialQuery: true,
        modeId: "agent",
        previousRequests: [],
      }),
    () =>
      vscode.commands.executeCommand("workbench.action.chat.open", {
        query: "@agent ",
        isPartialQuery: true,
        modeId: "agent",
      }),
    () =>
      vscode.commands.executeCommand("workbench.action.chat.open", {
        query: "@agent ",
        isPartialQuery: true,
      }),
    () => vscode.commands.executeCommand("workbench.action.chat.openagent"),
    () => vscode.commands.executeCommand("workbench.panel.chat"),
    () => vscode.commands.executeCommand("workbench.action.chat.open"),
  ];

  for (const run of attempts) {
    try {
      await run();
      try {
        await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
      } catch {
        /* ignore */
      }
      return;
    } catch {
      /* try next */
    }
  }
}
