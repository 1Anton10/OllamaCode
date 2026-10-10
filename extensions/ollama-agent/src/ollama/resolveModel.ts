import * as vscode from "vscode";
import { loadConfig } from "../config";
import { OllamaClient } from "./client";

function norm(name: string): string {
  return String(name || "")
    .trim()
    .replace(/^ollamacode\//i, "")
    .toLowerCase();
}

function sameModel(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const strip = (s: string) => s.replace(/:latest$/i, "");
  return strip(x) === strip(y);
}

function pickFromTags(preferred: string[], tags: string[]): string | undefined {
  for (const p of preferred) {
    const hit = tags.find((t) => sameModel(t, p));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Model for utility tasks (commit message, hub fit, …).
 * Prefers chat utility / defaultModel, but NEVER returns a name Ollama doesn't have.
 */
export async function resolveInstalledOllamaModel(
  client?: OllamaClient,
  preferred?: string
): Promise<{ model: string; note?: string; tags: string[] }> {
  const cfg = loadConfig();
  const c = client || new OllamaClient(cfg.ollama.baseUrl);

  let tags: string[] = [];
  try {
    const listed = await c.listModels();
    tags = listed.map((m) => m.name).filter(Boolean);
  } catch (e: any) {
    throw new Error(`Ollama недоступен (${cfg.ollama.baseUrl}): ${e?.message || e}`);
  }
  if (!tags.length) {
    throw new Error("В Ollama нет моделей — сделай ollama pull …");
  }

  const util = vscode.workspace
    .getConfiguration("chat")
    .get<{ vendor?: string; id?: string }>("utilityModel");
  const utilId =
    util?.vendor === "ollamacode" && util.id ? String(util.id) : undefined;

  const candidates = [
    preferred,
    utilId,
    cfg.ollama.defaultModel,
    "agent36:latest",
    "agent36",
    "agent35:latest",
    "agent35",
  ].filter((x): x is string => Boolean(x && String(x).trim()));

  const hit = pickFromTags(candidates, tags);
  if (hit) {
    const wanted = preferred || utilId || cfg.ollama.defaultModel;
    const note =
      wanted && !sameModel(hit, wanted)
        ? `«${wanted}» нет в Ollama → ${hit}`
        : undefined;
    return { model: hit, note, tags };
  }

  // Prefer any agent* / qwen*, else first tag
  const soft =
    tags.find((t) => /^agent/i.test(t)) ||
    tags.find((t) => /qwen/i.test(t)) ||
    tags[0];
  return {
    model: soft,
    note: `выбранная модель недоступна → ${soft}`,
    tags,
  };
}

/** Keep settings + hub aligned with the model the chat actually uses. */
export async function syncDefaultModel(modelId: string): Promise<void> {
  const id = String(modelId || "")
    .trim()
    .replace(/^ollamacode\//i, "");
  if (!id) return;
  const cfg = loadConfig();
  if (sameModel(cfg.ollama.defaultModel, id)) return;
  try {
    await vscode.workspace
      .getConfiguration("ollamaCode")
      .update("defaultModel", id, vscode.ConfigurationTarget.Global);
  } catch {
    /* ignore */
  }
  try {
    await vscode.workspace
      .getConfiguration("chat")
      .update(
        "utilityModel",
        { vendor: "ollamacode", id },
        vscode.ConfigurationTarget.Global
      );
  } catch {
    /* ignore */
  }
}

export async function ensureWorkspaceTrustedForNetwork(
  actionLabel: string
): Promise<boolean> {
  const trust = vscode.workspace.isTrusted;
  if (trust) return true;
  const pick = await vscode.window.showWarningMessage(
    `Workspace в Restricted Mode — ${actionLabel} (сеть/git) может быть заблокирован. Доверить папку?`,
    "Доверить",
    "Отмена"
  );
  if (pick !== "Доверить") return false;
  try {
    await vscode.commands.executeCommand(
      "workbench.trust.manage",
      vscode.workspace.workspaceFolders?.[0]?.uri
    );
  } catch {
    try {
      await vscode.commands.executeCommand("workbench.action.manageTrust");
    } catch {
      /* ignore */
    }
  }
  return vscode.workspace.isTrusted;
}
