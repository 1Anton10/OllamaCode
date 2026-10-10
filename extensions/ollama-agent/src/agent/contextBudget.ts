import * as vscode from "vscode";
import { ChatMessage } from "../ollama/client";
import { OllamaCodeConfig, loadConfig, ModelOverrides, HardwareProfile } from "../config";
import { nextPhysicalCtx, persistModelOverrides } from "./contextChipSync";

export function estimateTokens(
  history: ChatMessage[],
  userText: string,
  systemPrompt: string
): number {
  let chars = (systemPrompt || "").length + (userText || "").length;
  for (const m of history) chars += (m.content || "").length + (m.thinking || "").length + 8;
  return Math.max(1, Math.ceil(chars / 4));
}

export class ContextMeter {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 80);
    this.item.command = "ollamaCode.increaseContext";
    this.item.tooltip =
      "Физический KV (num_ctx) — что реально грузит Ollama. Клик — поднять num_ctx / VCTX.";
    this.item.show();
  }

  update(used: number, limit: number): void {
    const pct = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
    const usedK = (used / 1000).toFixed(1);
    const limK = (limit / 1000).toFixed(0);
    this.item.text = `$(dashboard) kv ${pct}% (${usedK}k/${limK}k)`;
    this.item.tooltip =
      `Физический KV num_ctx: ~${Math.round(used)} / ${limit} tokens. VCTX — отдельный архив, не этот кружок.`;
    this.item.backgroundColor =
      pct >= 90
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}

/** Silent bump of physical num_ctx (agent mid-turn). Returns new value or undefined. */
export async function autoRaisePhysicalCtx(
  modelId: string,
  current: number,
  profile: HardwareProfile = "medium"
): Promise<number | undefined> {
  const next = nextPhysicalCtx(current, profile);
  if (!next) return undefined;
  await persistModelOverrides(modelId, { numCtx: next });
  return next;
}

/** Raise physical Ollama num_ctx (prompt user). */
export async function maybeOfferContextIncrease(
  modelId: string,
  current: number,
  _cfg: OllamaCodeConfig
): Promise<number | undefined> {
  const next = nextPhysicalCtx(current, "medium") || (current < 65536 ? 65536 : 0);
  if (!next || next <= current) return undefined;

  const pick = await vscode.window.showInformationMessage(
    `Физический KV почти полный (${current}). Увеличить num_ctx до ${next} для ${modelId}?`,
    "Увеличить KV",
    "Нет"
  );
  if (pick !== "Увеличить KV") return undefined;

  await persistModelOverrides(modelId, { numCtx: next });
  return next;
}

function nextVirtualCtx(currentVirtual: number): number {
  const cur = Math.max(4096, currentVirtual || 32768);
  if (cur < 32768) return 32768;
  if (cur < 65536) return 65536;
  if (cur < 131072) return 131072;
  if (cur < 262144) return 262144;
  return 0;
}

/** Silent bump of virtual archive cap (agent mid-turn) — mirrors autoRaisePhysicalCtx. */
export async function autoRaiseVirtualCtx(
  modelId: string,
  currentVirtual: number
): Promise<number | undefined> {
  const next = nextVirtualCtx(currentVirtual);
  if (!next || next <= currentVirtual) return undefined;
  await persistModelOverrides(modelId, {
    chunkedContext: true,
    virtualCtx: next,
  });
  return next;
}

/** Raise virtualCtx target used by packer + chip (keeps physical num_ctx). */
export async function maybeOfferVirtualIncrease(
  modelId: string,
  currentVirtual: number
): Promise<number | undefined> {
  const next = nextVirtualCtx(currentVirtual);
  if (!next || next <= currentVirtual) return undefined;

  const pick = await vscode.window.showInformationMessage(
    `Виртуальный VCTX почти полный (${currentVirtual}). Поднять цель до ${next}? Физический num_ctx не меняется.`,
    "Поднять VCTX",
    "Нет"
  );
  if (pick !== "Поднять VCTX") return undefined;

  const patch: ModelOverrides = {
    chunkedContext: true,
    virtualCtx: next,
  };
  await persistModelOverrides(modelId, patch);
  return next;
}

export function registerContextCommands(
  context: vscode.ExtensionContext,
  meter: ContextMeter
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("ollamaCode.increaseContext", async () => {
      const cfg = loadConfig();
      const model = cfg.ollama.defaultModel;
      const over =
        cfg.models?.[model] || cfg.models?.[model.replace(/:latest$/i, "")] || {};
      const chunked = over.chunkedContext !== false;
      if (chunked) {
        const cur = over.virtualCtx || 32768;
        const raised = await maybeOfferVirtualIncrease(model, cur);
        if (raised) {
          meter.update(Math.floor(raised * 0.5), raised);
          void vscode.window.showInformationMessage(`virtualCtx → ${raised} (num_ctx без изменений)`);
        }
        return;
      }
      const raised = await maybeOfferContextIncrease(model, cfg.ollama.numCtx, cfg);
      if (raised) {
        meter.update(Math.floor(raised * 0.5), raised);
        void vscode.window.showInformationMessage(`num_ctx → ${raised}`);
      }
    }),
    meter
  );
}
