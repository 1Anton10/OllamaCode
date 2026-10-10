import { OllamaClient } from "./client";

/** Defaults declared in the model Modelfile / Ollama /api/show */
export interface ModelNativeDefaults {
  numCtx?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  seed?: number;
  numGpu?: number;
  numThread?: number;
  numBatch?: number;
  numPredict?: number;
  keepAlive?: string;
  /** Transformer block / layer count from model_info */
  layerCount?: number;
  /** Which model_info key provided layerCount (e.g. qwen3.block_count) */
  layerSource?: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  rawParameters: Record<string, string>;
}

function parseParamBlob(parameters: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof parameters === "string") {
    for (const line of parameters.split(/\r?\n/)) {
      const m = line.trim().match(/^([a-zA-Z0-9_]+)\s+(.+)$/);
      if (m) out[m[1].toLowerCase()] = m[2].trim();
    }
  } else if (parameters && typeof parameters === "object") {
    for (const [k, v] of Object.entries(parameters as Record<string, unknown>)) {
      if (v !== undefined && v !== null) out[k.toLowerCase()] = String(v);
    }
  }
  return out;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Extract block_count / layer count from model_info keys like llama.block_count */
export function extractLayerCount(
  modelInfo: Record<string, unknown> | undefined
): { count: number; source: string } | undefined {
  if (!modelInfo) return undefined;
  const candidates: { count: number; source: string; score: number }[] = [];
  for (const [k, v] of Object.entries(modelInfo)) {
    const key = k.toLowerCase();
    if (
      !(
        key.endsWith(".block_count") ||
        key.endsWith(".n_layer") ||
        key.endsWith(".n_layers") ||
        key === "block_count" ||
        key === "n_layer" ||
        key.endsWith(".n_layer_count")
      )
    ) {
      continue;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    // Prefer main transformer over vision/audio towers (e.g. qwen35moe.vision.block_count)
    let score = 10;
    if (key.includes("vision") || key.includes("audio") || key.includes("speech")) score -= 5;
    if (key.endsWith(".block_count")) score += 2;
    candidates.push({ count: Math.floor(n), source: k, score });
  }
  if (!candidates.length) return undefined;
  candidates.sort((a, b) => b.score - a.score || b.count - a.count);
  return { count: candidates[0].count, source: candidates[0].source };
}

export function parseShowDefaults(info: any): ModelNativeDefaults {
  const raw = parseParamBlob(info?.parameters);
  const details = info?.details || {};
  const modelInfo = (info?.model_info || {}) as Record<string, unknown>;
  const layers = extractLayerCount(modelInfo);
  const layerCount = layers?.count;

  let numGpu = num(raw.num_gpu);
  // Ollama often implies "all layers on GPU" when unset — surface as layerCount
  if (numGpu === undefined && layerCount !== undefined) {
    numGpu = layerCount;
  }

  return {
    numCtx: num(raw.num_ctx),
    temperature: num(raw.temperature),
    topP: num(raw.top_p),
    topK: num(raw.top_k),
    repeatPenalty: num(raw.repeat_penalty),
    seed: num(raw.seed),
    numGpu,
    numThread: num(raw.num_thread),
    numBatch: num(raw.num_batch),
    numPredict: num(raw.num_predict),
    keepAlive: raw.keep_alive,
    layerCount,
    layerSource: layers?.source,
    family: String(details.family || details.families?.[0] || ""),
    parameterSize: String(details.parameter_size || ""),
    quantization: String(details.quantization_level || ""),
    rawParameters: raw,
  };
}

export async function fetchModelDefaults(
  client: OllamaClient,
  model: string
): Promise<ModelNativeDefaults> {
  const info = await client.show(model);
  return parseShowDefaults(info);
}
