export interface OllamaModel {
  name: string;
  size?: number;
  modified_at?: string;
  details?: Record<string, unknown>;
}

export interface RunningModel {
  name: string;
  model: string;
  size: number;
  size_vram: number;
  expires_at?: string;
  /** Loaded KV window — /api/ps field (Ollama ≥0.5) */
  context_length?: number;
  details?: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  tool_name?: string;
  /** Native Ollama tool_calls on assistant turns — required for correct multi-step tool loops */
  tool_calls?: unknown[];
}

export interface GenerateOptions {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  think?: boolean;
  tools?: unknown[];
  options?: {
    temperature?: number;
    num_ctx?: number;
    num_predict?: number;
    num_gpu?: number;
    num_thread?: number;
    num_batch?: number;
    top_p?: number;
    top_k?: number;
    repeat_penalty?: number;
    seed?: number;
  };
  keep_alive?: string | number;
}

export class OllamaClient {
  constructor(private baseUrl: string) {}

  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/$/, "");
  }

  private url(p: string) {
    return `${this.baseUrl.replace(/\/$/, "")}${p}`;
  }

  async listModels(): Promise<OllamaModel[]> {
    const res = await fetch(this.url("/api/tags"));
    if (!res.ok) throw new Error(`Ollama /api/tags ${res.status}`);
    const data = (await res.json()) as { models?: OllamaModel[] };
    return data.models || [];
  }

  /** Models currently resident in RAM/VRAM */
  async listRunning(): Promise<RunningModel[]> {
    const res = await fetch(this.url("/api/ps"));
    if (!res.ok) throw new Error(`Ollama /api/ps ${res.status}`);
    const data = (await res.json()) as { models?: RunningModel[] };
    return data.models || [];
  }

  /** Unload from VRAM (keep_alive: 0) */
  async unloadModel(model: string): Promise<void> {
    const res = await fetch(this.url("/api/generate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: "",
        keep_alive: 0,
        stream: false,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`unload ${model}: ${res.status} ${t}`);
    }
    try {
      await res.json();
    } catch {
      /* ignore */
    }
  }

  /** Force-load model into VRAM with a tiny warmup chat */
  async warmupModel(
    model: string,
    opts?: { keepAlive?: string; numCtx?: number; numGpu?: number; numBatch?: number }
  ): Promise<void> {
    const options: Record<string, number> = {
      num_predict: 1,
      // Must match chat num_ctx — Ollama keeps the loaded KV size until unload
      num_ctx: Math.max(2048, opts?.numCtx ?? 8192),
    };
    if (typeof opts?.numGpu === "number" && Number.isFinite(opts.numGpu)) {
      options.num_gpu = opts.numGpu;
    }
    if (typeof opts?.numBatch === "number" && Number.isFinite(opts.numBatch) && opts.numBatch > 0) {
      options.num_batch = opts.numBatch;
    }
    const res = await fetch(this.url("/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "." }],
        stream: false,
        keep_alive: opts?.keepAlive ?? "30m",
        options,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`warmup ${model}: ${res.status} ${t}`);
    }
    try {
      await res.json();
    } catch {
      /* ignore */
    }
  }

  async show(model: string): Promise<any> {
    const res = await fetch(this.url("/api/show"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model }),
    });
    if (!res.ok) throw new Error(`Ollama /api/show ${res.status}`);
    return res.json();
  }

  private serializeMessages(messages: ChatMessage[]) {
    return messages.map((m) => ({
      role: m.role,
      content: m.content ?? "",
      ...(m.thinking ? { thinking: m.thinking } : {}),
      // Ollama uses tool_name; some OpenAI-compat forks want name
      ...(m.tool_name ? { tool_name: m.tool_name, name: m.tool_name } : {}),
      ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
    }));
  }

  async chat(opts: GenerateOptions): Promise<{ message: ChatMessage; raw: any }> {
    const body: any = {
      model: opts.model,
      messages: this.serializeMessages(opts.messages),
      stream: false,
      keep_alive: opts.keep_alive ?? "30m",
      options: opts.options || {},
    };
    if (typeof opts.think === "boolean") body.think = opts.think;
    if (opts.tools?.length) body.tools = opts.tools;

    const res = await fetch(this.url("/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      const err = `Ollama /api/chat ${res.status}: ${t}`;
      if (opts.think === true && /think|reasoning|not support/i.test(t)) {
        return this.chat({ ...opts, think: false });
      }
      if (opts.tools?.length && /tool|function.?call|not support/i.test(t)) {
        return this.chat({ ...opts, tools: undefined });
      }
      throw new Error(err);
    }
    const raw = (await res.json()) as {
      message?: { content?: string; thinking?: string; tool_calls?: unknown[] };
      thinking?: string;
    };
    const message: ChatMessage = {
      role: "assistant",
      content: raw?.message?.content || "",
      thinking: raw?.message?.thinking || raw?.thinking || undefined,
    };
    return { message, raw };
  }

  async *chatStream(opts: GenerateOptions): AsyncGenerator<any> {
    yield* this.chatStreamRaw(opts);
  }

  /**
   * Stream with automatic fallbacks so any Ollama model keeps working:
   * think unsupported → retry without think; tools rejected → text-protocol only.
   */
  async *chatStreamResilient(opts: GenerateOptions): AsyncGenerator<any> {
    try {
      yield* this.chatStreamRaw(opts);
      return;
    } catch (e: any) {
      const msg = String(e?.message || e || "");
      if (opts.think && /think|reasoning|not support/i.test(msg)) {
        yield* this.chatStreamRaw({ ...opts, think: false });
        return;
      }
      // Context overflow: drop tools once so the turn can still answer / compact upstream
      if (
        opts.tools?.length &&
        /exceed_context_size|exceeds the available context|n_prompt_tokens/i.test(msg)
      ) {
        const err = new Error(msg);
        (err as any).code = "EXCEED_CONTEXT";
        (err as any).ollamaContext = true;
        throw err;
      }
      if (opts.tools?.length && /tool|function.?call|not support/i.test(msg)) {
        yield* this.chatStreamRaw({ ...opts, tools: undefined });
        return;
      }
      throw e;
    }
  }

  private async *chatStreamRaw(opts: GenerateOptions): AsyncGenerator<any> {
    const body: any = {
      model: opts.model,
      messages: this.serializeMessages(opts.messages),
      stream: true,
      keep_alive: opts.keep_alive ?? "30m",
      options: opts.options || {},
    };
    // Only send think when enabled — some builds reject think:false
    if (typeof opts.think === "boolean") body.think = opts.think;
    if (opts.tools?.length) body.tools = opts.tools;

    const res = await fetch(this.url("/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const t = await res.text();
      throw new Error(`Ollama stream ${res.status}: ${t}`);
    }

    const reader = (res.body as any).getReader?.();
    if (!reader) {
      const text = await res.text();
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        yield JSON.parse(line);
      }
      return;
    }

    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() || "";
      for (const line of parts) {
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line);
        } catch {
          /* ignore partial */
        }
      }
    }
  }
}
