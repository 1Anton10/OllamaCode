import { OllamaClient } from "./client";
import { ThinkingMode } from "../config";

export interface ModelCapabilities {
  model: string;
  supportsThinking: boolean;
  supportsTools: boolean;
  family?: string;
  reasons: string[];
}

export async function detectCapabilities(
  client: OllamaClient,
  model: string
): Promise<ModelCapabilities> {
  const reasons: string[] = [];
  let supportsThinking = false;
  // All Ollama models can use tools via native tool_calls and/or JSON/XML text protocol.
  let supportsTools = true;
  let family: string | undefined;

  try {
    const info = await client.show(model);
    const details = info?.details || {};
    family = String(details.family || details.families?.[0] || "");
    const modelfile = String(info?.modelfile || "");
    const template = String(info?.template || "");
    const modelInfo = JSON.stringify(info?.model_info || {}).toLowerCase();
    const blob = `${modelfile}\n${template}\n${modelInfo}\n${family}`.toLowerCase();

    if (
      /renderer\s+qwen3|parser\s+qwen3|qwen3\.5|qwen3|thinking|<\/?think>|<think>/.test(blob) ||
      /deepseek-r1|reasoner|magistral|qwq|hunyuan|seed-thinking/.test(blob)
    ) {
      supportsThinking = true;
      reasons.push("model metadata indicates native thinking");
    } else {
      reasons.push("no thinking markers in model metadata");
    }

    reasons.push("tools enabled for all Ollama models (native + text protocol)");
  } catch (e: any) {
    reasons.push(`show failed: ${e?.message || e}`);
    const n = model.toLowerCase();
    if (/qwen3|r1|reason|think|qwq|magistral|abliterat/.test(n)) {
      supportsThinking = true;
      reasons.push("name heuristic: thinking-capable");
    }
    reasons.push("tools enabled (fallback)");
  }

  return { model, supportsThinking, supportsTools, family, reasons };
}

export function resolveThinking(
  mode: ThinkingMode,
  caps: ModelCapabilities,
  _userText?: string
): { enabled: boolean; note: string } {
  if (mode === "on") {
    return {
      enabled: caps.supportsThinking,
      note: caps.supportsThinking
        ? "thinking forced on"
        : "thinking requested but model lacks native thinking — disabled",
    };
  }
  if (mode === "off") {
    return { enabled: false, note: "thinking forced off" };
  }
  // auto — never silently disable thinking when the model supports it
  return {
    enabled: caps.supportsThinking,
    note: caps.supportsThinking
      ? "auto: thinking enabled"
      : "auto: thinking disabled (model cannot think)",
  };
}

export function isOomError(msg: string): boolean {
  return /bad_alloc|out of memory|oom|GGML_ASSERT|cannot allocate|std::bad_alloc|cuda.*memory|failed to allocate/i.test(
    msg || ""
  );
}
