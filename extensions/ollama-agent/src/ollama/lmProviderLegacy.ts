/**
 * Code-OSS 1.99 API adapter: vscode.lm.registerChatModelProvider
 * (registerLanguageModelChatProvider arrived in later VS Code).
 */
import * as vscode from "vscode";
import { OllamaClient } from "./client";
import { detectCapabilities, resolveThinking } from "./capabilities";
import { loadConfig, resolveModelRuntime } from "../config";

function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function partsToText(messages: ReadonlyArray<any>): Array<{ role: string; content: string }> {
  return messages.map((msg) => {
    const role =
      msg.role === vscode.LanguageModelChatMessageRole.Assistant
        ? "assistant"
        : msg.role === vscode.LanguageModelChatMessageRole.User
          ? "user"
          : "system";
    const parts: string[] = [];
    for (const part of msg.content || []) {
      if (part instanceof vscode.LanguageModelTextPart) parts.push(part.value);
      else if (typeof part?.value === "string") parts.push(part.value);
      else parts.push(JSON.stringify(part));
    }
    return { role, content: parts.join("\n") };
  });
}

class SingleModelProvider {
  constructor(
    private readonly modelName: string,
    private readonly supportsThinking: boolean,
    private readonly client: OllamaClient
  ) {}

  async provideLanguageModelResponse(
    messages: any[],
    options: any,
    _extensionId: string,
    progress: vscode.Progress<{ index: number; part: any }>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const cfg = loadConfig();
    this.client.setBaseUrl(cfg.ollama.baseUrl);
    const rt = resolveModelRuntime(this.modelName, cfg);
    const resolved = resolveThinking(rt.thinking, {
      model: this.modelName,
      supportsThinking: this.supportsThinking,
      supportsTools: true,
      reasons: [],
    });

    const chatMessages = partsToText(messages);
    if (!chatMessages.some((m) => m.role === "system")) {
      chatMessages.unshift({ role: "system", content: rt.systemPrompt });
    }

    const tools =
      options?.tools?.map((t: any) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema || { type: "object", properties: {} },
        },
      })) || undefined;

    let index = 0;
    try {
      for await (const chunk of this.client.chatStreamResilient({
        model: this.modelName,
        messages: chatMessages as any,
        think: resolved.enabled,
        tools,
        options: { temperature: rt.temperature, num_ctx: rt.numCtx },
        keep_alive: rt.keepAlive,
      })) {
        if (token.isCancellationRequested) return;
        const delta = chunk?.message?.content || "";
        if (delta) {
          progress.report({ index: index++, part: new vscode.LanguageModelTextPart(delta) });
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
              progress.report({
                index: index++,
                part: new (vscode as any).LanguageModelToolCallPart(
                  tc.id || `call_${Date.now()}`,
                  name,
                  args
                ),
              });
            }
          }
        }
      }
    } catch (e: any) {
      progress.report({
        index: index++,
        part: new vscode.LanguageModelTextPart(`[Ollama error] ${e?.message || e}`),
      });
    }
  }

  async provideTokenCount(text: any, _token: vscode.CancellationToken): Promise<number> {
    if (typeof text === "string") return approxTokens(text);
    return approxTokens(partsToText([text])[0]?.content || "");
  }
}

export async function registerLegacyChatModels(
  context: vscode.ExtensionContext
): Promise<{ refresh: () => Promise<void> }> {
  const lm = vscode.lm as any;
  if (typeof lm.registerChatModelProvider !== "function") {
    throw new Error("registerChatModelProvider unavailable");
  }

  const client = new OllamaClient(loadConfig().ollama.baseUrl);
  const disposables: vscode.Disposable[] = [];

  const refresh = async () => {
    for (const d of disposables.splice(0)) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    const cfg = loadConfig();
    client.setBaseUrl(cfg.ollama.baseUrl);
    let models: Awaited<ReturnType<OllamaClient["listModels"]>> = [];
    try {
      models = await client.listModels();
    } catch (e: any) {
      void vscode.window.showWarningMessage(`OllamaCode: Ollama недоступен (${e?.message || e})`);
      return;
    }

    for (const m of models) {
      const capsPromise = detectCapabilities(client, m.name).catch(() => ({
        model: m.name,
        supportsThinking: /qwen3|r1|think/i.test(m.name),
        supportsTools: true,
        family: "ollama",
        reasons: ["fallback"],
      }));
      // fire all shows in parallel below
      (m as any).__caps = capsPromise;
    }
    await Promise.all(models.map((m: any) => m.__caps));
    for (const m of models) {
      const caps = await (m as any).__caps;
      const provider = new SingleModelProvider(m.name, caps.supportsThinking, client);
      const isDefault = m.name === cfg.ollama.defaultModel;
      const d = lm.registerChatModelProvider(m.name, provider, {
        vendor: "ollamacode",
        name: m.name,
        family: caps.family || "ollama",
        version: "local",
        maxInputTokens: Math.max(cfg.ollama.numCtx, 8192),
        maxOutputTokens: 8192,
        isDefault,
        isUserSelectable: true,
        capabilities: { toolCalling: true, agentMode: true },
      }) as vscode.Disposable;
      disposables.push(d);
      context.subscriptions.push(d);
    }
  };

  await refresh();
  return { refresh };
}
