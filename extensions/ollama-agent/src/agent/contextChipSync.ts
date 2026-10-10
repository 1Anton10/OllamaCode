/**
 * Bidirectional sync: chat Context chip (modelConfiguration.contextSize)
 * ↔ ollamaCode models (virtualCtx + physical numCtx).
 *
 * Chip = what the user picks (32K/128K). That is the virtual window.
 * Physical num_ctx follows the chip up to a hardware-profile safe cap
 * (so Ollama is not stuck at Modelfile's PARAMETER num_ctx 8192).
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  loadConfig,
  ModelOverrides,
  ThinkingMode,
  HardwareProfile,
  defaultExternalConfigPath,
} from "../config";

/** Max physical KV by profile (VRAM budget). Virtual can still be higher via VCTX. */
export const PHYSICAL_CAP: Record<HardwareProfile, number> = {
  // 8GB VRAM + system RAM offload can hold large KV for MoE-A3B (user-proven ~200K).
  light: 262144, // fewer GPU layers → more room for KV
  medium: 200000,
  max: 65536, // max GPU layers → less room for KV
};

/** Next physical num_ctx step up to profile cap (0 = already at cap). */
export function nextPhysicalCtx(
  current: number,
  profile: HardwareProfile = "medium"
): number {
  const cap = PHYSICAL_CAP[profile] ?? 32768;
  const cur = Math.max(2048, current || 8192);
  if (cur >= cap) return 0;
  const step =
    cur < 16384
      ? 16384
      : cur < 32768
        ? 32768
        : cur < 65536
          ? 65536
          : cur < 131072
            ? 131072
            : Math.min(cap, cur * 2);
  return step > cur ? Math.min(cap, step) : 0;
}

/** Map Context chip → physical num_ctx (capped by profile). */
export function physicalCtxFromChip(
  chip: number,
  profile: HardwareProfile = "medium",
  modelMax?: number
): number {
  const cap = PHYSICAL_CAP[profile] ?? 32768;
  const modelCap = typeof modelMax === "number" && modelMax > 0 ? modelMax : 262144;
  return Math.max(8192, Math.min(Math.floor(chip), cap, modelCap));
}

/** Apply chip to a runtime object (mutates). */
export function applyContextChip(
  rt: {
    numCtx: number;
    virtualCtx?: number;
    chunkedContext?: boolean;
    hardwareProfile?: HardwareProfile;
  },
  chip: number,
  modelMax?: number
): void {
  if (!(chip > 0)) return;
  const profile = (rt.hardwareProfile || "medium") as HardwareProfile;
  rt.virtualCtx = Math.max(4096, Math.floor(chip));
  rt.numCtx = physicalCtxFromChip(chip, profile, modelMax);
  if (rt.chunkedContext === undefined) rt.chunkedContext = true;
}

/** Value shown on the chat Context chip / schema default. */
export function chipContextSize(rt: {
  numCtx: number;
  virtualCtx?: number;
  chunkedContext?: boolean;
}): number {
  if (rt.chunkedContext !== false) {
    return Math.max(4096, rt.virtualCtx || rt.numCtx || 32768);
  }
  return Math.max(2048, rt.numCtx || 8192);
}

function mergeModelIntoFile(modelId: string, patch: ModelOverrides): void {
  const cfg = loadConfig();
  const p = cfg._configPath || defaultExternalConfigPath();
  let file: any = {};
  try {
    if (fs.existsSync(p)) file = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    file = {};
  }
  if (!file.models || typeof file.models !== "object") file.models = {};
  const prev = file.models[modelId] || {};
  file.models[modelId] = { ...prev, ...patch };
  // Keep global ollama.numCtx aligned with physical window when provided
  if (typeof patch.numCtx === "number" && patch.numCtx > 0) {
    file.ollama = { ...(file.ollama || {}), numCtx: patch.numCtx };
  }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(file, null, 2), "utf8");
  } catch {
    /* ignore disk errors — VS settings still updated */
  }
}

/** Persist model overrides to VS settings + ~/.ollamacode/config.json */
export async function persistModelOverrides(
  modelId: string,
  patch: ModelOverrides
): Promise<void> {
  const vs = vscode.workspace.getConfiguration("ollamaCode");
  const models = { ...(vs.get<Record<string, any>>("models") || {}) };
  models[modelId] = { ...(models[modelId] || {}), ...patch };
  await vs.update("models", models, true);
  if (typeof patch.numCtx === "number" && patch.numCtx > 0) {
    await vs.update("numCtx", patch.numCtx, true);
  }
  if (patch.thinking === "auto" || patch.thinking === "on" || patch.thinking === "off") {
    await vs.update("thinking", patch.thinking, true);
  }
  mergeModelIntoFile(modelId, patch);
}

/** Settings panel → chat Context chip */
export async function pushChipFromSettings(
  modelId: string,
  rt: { numCtx: number; virtualCtx?: number; chunkedContext?: boolean; thinking?: ThinkingMode }
): Promise<void> {
  const contextSize = chipContextSize(rt);
  try {
    await vscode.commands.executeCommand("ollamaCode.bridgeModelConfiguration", {
      modelId,
      contextSize,
      thinkingEffort: rt.thinking || "auto",
    });
  } catch {
    /* workbench bridge may be missing until rebundle */
  }
}

/** Chat chip → settings (virtual + physical, profile-capped) */
export async function pullChipIntoSettings(
  modelId: string,
  opts: { contextSize?: number; thinkingEffort?: string }
): Promise<void> {
  const cfg = loadConfig();
  const rt = cfg.models?.[modelId] || cfg.models?.[modelId.replace(/:latest$/, "")] || {};
  const patch: ModelOverrides = {};
  if (typeof opts.contextSize === "number" && opts.contextSize > 0) {
    const profile = (rt.hardwareProfile || "medium") as HardwareProfile;
    patch.chunkedContext = true;
    patch.virtualCtx = opts.contextSize;
    patch.numCtx = physicalCtxFromChip(opts.contextSize, profile);
  }
  if (
    opts.thinkingEffort === "auto" ||
    opts.thinkingEffort === "on" ||
    opts.thinkingEffort === "off"
  ) {
    patch.thinking = opts.thinkingEffort;
  }
  if (!Object.keys(patch).length) return;
  await persistModelOverrides(modelId, patch);
}
