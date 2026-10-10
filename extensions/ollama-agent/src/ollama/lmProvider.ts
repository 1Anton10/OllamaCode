import * as vscode from "vscode";
import { OllamaClient } from "./client";
import { detectCapabilities, resolveThinking } from "./capabilities";
import { loadConfig, resolveModelRuntime, ThinkingMode, buildOllamaOptions } from "../config";
import { chipContextSize } from "../agent/contextChipSync";
import { buildHubContextPack } from "../marketplace/contextPack";

export const ACTION_DOWNLOAD_HF = "__ollamacode.action.download_hf";
export const ACTION_REFRESH = "__ollamacode.action.refresh";

type ModelInfo = vscode.LanguageModelChatInformation & {
  /** ollama tag */
  ollamaName: string;
  supportsThinking: boolean;
  isAction?: boolean;
  /** 1.140 picker default — not yet in @types/vscode shipped with extension */
  isDefault?: boolean;
  isUserSelectable?: boolean;
  isBYOK?: boolean;
  maxContextWindowTokens?: number;
  category?: string;
  configurationSchema?: Record<string, unknown>;
  statusIcon?: vscode.ThemeIcon;
};

/** Workbench-registered llama mark (see modelProviderIcons OLLAMACODE_LLAMA_ICON). */
const OLLAMA_STATUS_ICON = new vscode.ThemeIcon("chat-model-provider-ollama");

const CONTEXT_SIZE_ENUM = [4096, 8192, 16384, 32768, 65536, 131072, 200000] as const;
const CONTEXT_SIZE_LABELS = ["4K", "8K", "16K", "32K", "64K", "128K", "200K"] as const;

/** Schema that unlocks the model-picker gear (thinking effort + context size). */
function buildConfigurationSchema(supportsThinking: boolean, defaultCtx: number) {
  const ctxDefault = CONTEXT_SIZE_ENUM.includes(defaultCtx as (typeof CONTEXT_SIZE_ENUM)[number])
    ? defaultCtx
    : 8192;
  const properties: Record<string, unknown> = {
    contextSize: {
      type: "number",
      title: "Context Size",
      description:
        "Context window (VCTX + physical num_ctx). Physical follows this up to the hardware profile cap (Medium ≤200K).",
      enum: [...CONTEXT_SIZE_ENUM],
      enumItemLabels: [...CONTEXT_SIZE_LABELS],
      default: ctxDefault,
      group: "tokens",
    },
  };
  // Always expose Thinking so the picker shows the effort tag / gear even when
  // name heuristics miss (e.g. custom agent35). Runtime still respects capability.
  properties.thinkingEffort = {
    type: "string",
    title: "Thinking",
    description: "Enable model thinking / chain-of-thought",
    enum: ["auto", "on", "off"],
    enumItemLabels: ["Auto", "On", "Off"],
    default: supportsThinking ? "auto" : "off",
    group: "navigation",
  };
  return { type: "object", properties };
}

function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Fast name-only heuristics — never block the model picker on /api/show. */
function quickCaps(model: string): { supportsThinking: boolean; family: string } {
  const n = model.toLowerCase();
  const supportsThinking =
    /qwen3|r1|reason|think|abliterat|agent|deepseek|o1|o3|o4|gpt-oss|magistral/.test(n);
  let family = "ollama";
  if (/qwen/.test(n)) family = "qwen";
  else if (/llama/.test(n)) family = "llama";
  else if (/mistral|mixtral|magistral/.test(n)) family = "mistral";
  else if (/deepseek/.test(n)) family = "deepseek";
  else if (/gemma/.test(n)) family = "gemma";
  else if (/agent/.test(n)) family = "agent";
  return { supportsThinking, family };
}

function messageToText(msg: vscode.LanguageModelChatRequestMessage): { role: string; content: string } {
  const role =
    msg.role === vscode.LanguageModelChatMessageRole.Assistant
      ? "assistant"
      : msg.role === vscode.LanguageModelChatMessageRole.User
        ? "user"
        : "system";
  const parts: string[] = [];
  for (const part of msg.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      parts.push(part.value);
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      parts.push(
        JSON.stringify({
          name: part.name,
          arguments: part.input,
          id: part.callId,
        })
      );
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      const texts = (part.content || [])
        .map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : JSON.stringify(c)))
        .join("\n");
      parts.push(`TOOL_RESULT ${part.callId}:\n${texts}`);
    }
  }
  return { role, content: parts.join("\n") };
}

export class OllamaLanguageModelProvider implements vscode.LanguageModelChatProvider<ModelInfo> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;
  private client: OllamaClient;
  private lastManagePromptAt = 0;
  /** Cache listModels for a few seconds so reload/picker doesn't flicker empty. */
  private listCache: { at: number; models: Awaited<ReturnType<OllamaClient["listModels"]>> } | null =
    null;

  constructor() {
    const cfg = loadConfig();
    this.client = new OllamaClient(cfg.ollama.baseUrl);
  }

  refresh() {
    const cfg = loadConfig();
    this.client.setBaseUrl(cfg.ollama.baseUrl);
    this.listCache = null;
    this._onDidChange.fire();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<ModelInfo[]> {
    const cfg = loadConfig();
    this.client.setBaseUrl(cfg.ollama.baseUrl);

    // Gear next to "Other Models" → silent=false → open HF download menu.
    // Never do this during silent boot enumeration (that caused picker flicker).
    if (!options.silent) {
      const now = Date.now();
      if (now - this.lastManagePromptAt > 2500) {
        this.lastManagePromptAt = now;
        setTimeout(() => {
          void vscode.commands.executeCommand("ollamaCode.manageModels");
        }, 80);
      }
    }

    let models: Awaited<ReturnType<OllamaClient["listModels"]>> = [];
    try {
      const now = Date.now();
      if (this.listCache && now - this.listCache.at < 8000) {
        models = this.listCache.models;
      } else {
        models = await this.client.listModels();
        this.listCache = { at: now, models };
      }
    } catch (e: any) {
      if (!options.silent) {
        void vscode.window
          .showWarningMessage(
            `Ollama недоступна (${e?.message || e}). Установи Ollama и выбери модели.`,
            "Установить / модели"
          )
          .then((c) => {
            if (c) void vscode.commands.executeCommand("ollamaCode.manageModels");
          });
      }
      return [];
    }

    // Real Ollama tags only — fake "action" rows broke 1.140 model selection persistence.
    const defaultId = cfg.ollama.defaultModel;
    const out: ModelInfo[] = [];
    for (const m of models) {
      const caps = quickCaps(m.name);
      const isDefault =
        m.name === defaultId ||
        m.name.replace(/:latest$/i, "") === defaultId.replace(/:latest$/i, "");
      const rt = resolveModelRuntime(m.name, cfg);
      const physical = Math.max(2048, rt.numCtx || cfg.ollama.numCtx);
      // Picker chip / schema = virtual; Session Info ring must use PHYSICAL KV (num_ctx).
      const chip = chipContextSize(rt);
      out.push({
        id: m.name,
        name: m.name,
        family: caps.family,
        version: "local",
        maxInputTokens: physical,
        maxOutputTokens: Math.min(8192, Math.floor(physical / 4)),
        maxContextWindowTokens: physical,
        tooltip: caps.supportsThinking
          ? "Ollama · thinking (auto) · tools"
          : "Ollama · tools",
        // Shown as list/hover badge — "thinking" when the model supports it
        detail: caps.supportsThinking ? "thinking" : "local",
        category: caps.supportsThinking ? "thinking" : "versatile",
        capabilities: {
          toolCalling: true,
          imageInput: false,
        },
        configurationSchema: buildConfigurationSchema(caps.supportsThinking, chip),
        // Persist selection as vendor/id (ollamacode/agent35:latest), not extensionId/id
        isDefault: isDefault ? true : undefined,
        isUserSelectable: true,
        isBYOK: true,
        statusIcon: OLLAMA_STATUS_ICON,
        ollamaName: m.name,
        supportsThinking: caps.supportsThinking,
      });
    }

    out.sort((a, b) => {
      if (a.isDefault && !b.isDefault) return -1;
      if (!a.isDefault && b.isDefault) return 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  async provideLanguageModelChatResponse(
    model: ModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const cfg = loadConfig();
    this.client.setBaseUrl(cfg.ollama.baseUrl);

    // Refine thinking from /api/show only when actually chatting.
    let supportsThinking = model.supportsThinking;
    try {
      const caps = await detectCapabilities(this.client, model.ollamaName);
      supportsThinking = caps.supportsThinking;
    } catch {
      /* keep heuristic */
    }

    const rt = resolveModelRuntime(model.ollamaName, cfg);
    const modelCfg = (options as any)?.modelConfiguration as
      | { thinkingEffort?: string; contextSize?: number }
      | undefined;
    if (typeof modelCfg?.contextSize === "number" && modelCfg.contextSize > 0) {
      const { applyContextChip } = require("../agent/contextChipSync") as typeof import("../agent/contextChipSync");
      applyContextChip(rt, modelCfg.contextSize);
    }
    if (modelCfg?.thinkingEffort === "auto" || modelCfg?.thinkingEffort === "on" || modelCfg?.thinkingEffort === "off") {
      rt.thinking = modelCfg.thinkingEffort;
    }
    const thinkingMode = rt.thinking;
    const resolved = resolveThinking(thinkingMode, {
      model: model.ollamaName,
      supportsThinking,
      supportsTools: true,
      reasons: [],
    });

    const chatMsgs = messages.map(messageToText).filter((m) => m.content.trim().length > 0);
    if (rt.systemPrompt) {
      chatMsgs.unshift({ role: "system", content: rt.systemPrompt });
    }

    try {
      const lastUser = [...chatMsgs].reverse().find((m) => m.role === "user")?.content || "";
      const pack = buildHubContextPack({ userText: lastUser });
      if (pack.text) {
        const sys = chatMsgs.find((m) => m.role === "system");
        if (sys) sys.content = `${sys.content}\n\n${pack.text}`;
        else chatMsgs.unshift({ role: "system", content: pack.text });
      }
    } catch {
      /* optional */
    }

    // Forward VS Code / Configure Tools schemas so any caller of the LM provider
    // (subagents, native loops) gets the same Built-In tool surface.
    const tools =
      options?.tools?.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema || { type: "object", properties: {} },
        },
      })) || undefined;

    const stream = this.client.chatStreamResilient({
      model: model.ollamaName,
      messages: chatMsgs as any,
      stream: true,
      think: resolved.enabled,
      tools,
      options: buildOllamaOptions(rt),
      keep_alive: rt.keepAlive,
    });

    let promptEval = 0;
    let evalCount = 0;
    for await (const chunk of stream) {
      if (token.isCancellationRequested) break;
      if (typeof chunk?.prompt_eval_count === "number") promptEval = chunk.prompt_eval_count;
      if (typeof chunk?.eval_count === "number") evalCount = chunk.eval_count;
      const content = chunk?.message?.content;
      if (typeof content === "string" && content.length) {
        progress.report(new vscode.LanguageModelTextPart(content));
      }
      const thinking = (chunk?.message as any)?.thinking;
      if (typeof thinking === "string" && thinking.length) {
        try {
          progress.report(new (vscode as any).LanguageModelThinkingPart(thinking));
        } catch {
          /* thinking part optional */
        }
      }
      const tcs = chunk?.message?.tool_calls;
      if (Array.isArray(tcs) && chunk?.done) {
        for (const tc of tcs) {
          const name = tc?.function?.name || tc?.name;
          let args = tc?.function?.arguments ?? tc?.arguments ?? {};
          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch {
              args = { raw: args };
            }
          }
          if (name) {
            try {
              progress.report(
                new (vscode as any).LanguageModelToolCallPart(
                  tc.id || `call_${Date.now()}`,
                  name,
                  args
                )
              );
            } catch {
              /* ToolCallPart optional on older typings */
            }
          }
        }
      }
    }
    // Token usage is reported via the chat participant stream.usage() path for Agent UI.
    void promptEval;
    void evalCount;
  }

  async provideTokenCount(
    _model: ModelInfo,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    if (typeof text === "string") return approxTokens(text);
    return approxTokens(messageToText(text).content);
  }
}
