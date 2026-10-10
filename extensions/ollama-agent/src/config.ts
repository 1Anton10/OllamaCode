import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export type ThinkingMode = "auto" | "on" | "off";
export type HardwareProfile = "light" | "medium" | "max";

export interface ModelOverrides {
  systemPrompt?: string;
  temperature?: number;
  numCtx?: number;
  /** Virtual / chunked memory target (UI + packer), independent of physical num_ctx. */
  virtualCtx?: number;
  /** Enable chunked context packing when history exceeds the window. Default true. */
  chunkedContext?: boolean;
  thinking?: ThinkingMode;
  keepAlive?: string;
  /** Smart offload preset — expands to numGpu/numCtx/batch when applied. */
  hardwareProfile?: HardwareProfile;
  /** Layers offloaded to GPU (Ollama num_gpu). Rest stay in system RAM/CPU. */
  numGpu?: number;
  /** CPU thread count (Ollama num_thread). */
  numThread?: number;
  numBatch?: number;
  numPredict?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  seed?: number;
}

export interface OllamaCodeConfig {
  _configPath: string;
  ollama: {
    baseUrl: string;
    defaultModel: string;
    numCtx: number;
    temperature: number;
    keepAlive: string;
  };
  chat: {
    thinking: ThinkingMode;
    language: string;
    systemPrompt: string;
    /**
     * Max model↔tool rounds per user turn.
     * 0 / omitted = no ceiling (stop only on final answer, cancel, or error).
     */
    agentMaxSteps?: number;
  };
  /** Per-model overrides keyed by Ollama model name / tag. */
  models: Record<string, ModelOverrides>;
  tools: {
    allowJson: boolean;
    allowXml: boolean;
    autoApproveRead: boolean;
    autoApproveWrite: boolean;
    autoApproveTerminal: boolean;
  };
  ui: {
    title: string;
    showThinking: boolean;
  };
}

const DEFAULTS: Omit<OllamaCodeConfig, "_configPath"> = {
  ollama: {
    baseUrl: "http://127.0.0.1:11434",
    defaultModel: "agent36:latest",
    // Physical KV — chat Context chip maps here via profile cap (Medium ≤200K)
    numCtx: 200000,
    temperature: 0.6,
    keepAlive: "5m",
  },
  chat: {
    thinking: "auto",
    language: "ru",
    agentMaxSteps: 0,
    systemPrompt:
      "Ты локальный агент OllamaCode. Отвечай на языке пользователя (и thinking тоже — без переключения на китайский/中文). Доводи задачу до рабочего результата в этом же ходе: короткий план → сразу tools (писать/запускать/чинить/проверять), не останавливайся на плане и не отказывайся «слишком большое» — делай MVP и итерируй. Действия только через tools. Не утверждай успех без реального результата tool. После tools — новые tool_calls или законченный итог (не обрывай на «Исправляю:» / Fixing:). Thinking — коротко и по делу (следующий tool, риск, проверка), без воды и без повторов одной фразы. При FAILED/BLOCKED не повторяй ту же команду. Секреты (.env, BOT_TOKEN): ставь явную заглушку и в итоге скажи пользователю подставить свой токен — не выдавай пример Telegram `123456:ABC-…` за рабочий. Workspace уже открыт — не open_workspace на выдуманные пути.",
  },
  models: {
    "agent36:latest": {
      temperature: 0.6,
      hardwareProfile: "medium",
      numCtx: 200000,
      virtualCtx: 200000,
      chunkedContext: true,
      numPredict: -1,
      numBatch: 256,
      thinking: "auto",
      keepAlive: "5m",
      systemPrompt:
        "Ты агент OllamaCode (Qwen3.6). Ответ и thinking только по-русски (или язык пользователя) — никогда не уходи в 中文 mid-thought. Доводи задачу до рабочего результата в этом же ходе: короткий план → сразу tools (писать/запускать/чинить/проверять), не останавливайся на плане и не отказывайся «слишком большое» — делай MVP и итерируй. Tools реальные. Не выдумывай stdout. Thinking коротко: решение + риск, без эссе и без повторов. Простые файлы — write_to_file сразу. Заглушки токенов в .env — всегда предупреждай пользователя.",
    },
    "agent35:latest": {
      temperature: 0.3,
      hardwareProfile: "medium",
      numCtx: 16384,
      virtualCtx: 32768,
      chunkedContext: true,
      numGpu: 28,
      numPredict: -1,
      numBatch: 256,
      thinking: "auto",
      keepAlive: "5m",
      systemPrompt:
        "Ты агент OllamaCode (Qwen). Ответ и thinking только по-русски (или язык пользователя) — никогда не уходи в 中文 mid-thought. Доводи задачу до рабочего результата в этом же ходе: короткий план → сразу tools (писать/запускать/чинить/проверять), не останавливайся на плане и не отказывайся «слишком большое» — делай MVP и итерируй. Tools реальные. Не выдумывай stdout. Thinking коротко: решение + риск, без эссе. Простые файлы — write_to_file сразу. Заглушки токенов в .env — всегда предупреждай пользователя.",
    },
  },
  tools: {
    allowJson: true,
    allowXml: true,
    autoApproveRead: true,
    autoApproveWrite: false,
    autoApproveTerminal: false,
  },
  ui: {
    title: "OllamaCode Chat",
    showThinking: true,
  },
};

function deepMerge<T extends Record<string, any>>(base: T, over: any): T {
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  if (!over || typeof over !== "object") return out;
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object") {
      out[k] = deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function defaultExternalConfigPath(): string {
  return path.join(os.homedir(), ".ollamacode", "config.json");
}

export async function ensureExternalConfig(): Promise<string> {
  const p = defaultExternalConfigPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, JSON.stringify(DEFAULTS, null, 2), "utf8");
  }
  return p;
}

export function loadConfig(context?: vscode.ExtensionContext): OllamaCodeConfig {
  const vs = vscode.workspace.getConfiguration("ollamaCode");
  const override = (vs.get<string>("externalConfigPath") || "").trim();
  const configPath = override || defaultExternalConfigPath();

  let fileCfg: any = {};
  try {
    if (fs.existsSync(configPath)) {
      fileCfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
  } catch {
    fileCfg = {};
  }

  // workspace overlay
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (ws) {
    const wsCfgPath = path.join(ws, ".ollamacode", "config.json");
    try {
      if (fs.existsSync(wsCfgPath)) {
        fileCfg = deepMerge(fileCfg, JSON.parse(fs.readFileSync(wsCfgPath, "utf8")));
      }
    } catch {
      /* ignore */
    }
  }

  let cfg = deepMerge({ ...DEFAULTS, _configPath: configPath } as OllamaCodeConfig, fileCfg);
  cfg._configPath = configPath;

  // VS Code settings override file (for quick UI tweaks)
  if (vs.get("baseUrl")) cfg.ollama.baseUrl = vs.get<string>("baseUrl")!;
  if (vs.get("defaultModel")) cfg.ollama.defaultModel = vs.get<string>("defaultModel")!;
  if (vs.get("thinking")) cfg.chat.thinking = vs.get<ThinkingMode>("thinking")!;
  if (vs.get("numCtx")) cfg.ollama.numCtx = vs.get<number>("numCtx")!;
  if (vs.get("temperature") !== undefined) cfg.ollama.temperature = vs.get<number>("temperature")!;
  if (vs.get("agentMaxSteps") !== undefined) {
    const n = Number(vs.get("agentMaxSteps"));
    if (Number.isFinite(n) && n >= 0) cfg.chat.agentMaxSteps = n;
  }
  if (vs.get("autoApproveRead") !== undefined) {
    cfg.tools.autoApproveRead = Boolean(vs.get("autoApproveRead"));
  }
  if (vs.get("autoApproveWrite") !== undefined) {
    cfg.tools.autoApproveWrite = Boolean(vs.get("autoApproveWrite"));
  }
  if (vs.get("autoApproveTerminal") !== undefined) {
    cfg.tools.autoApproveTerminal = Boolean(vs.get("autoApproveTerminal"));
  }

  const modelsSetting = vs.get<Record<string, ModelOverrides>>("models");
  if (modelsSetting && typeof modelsSetting === "object") {
    cfg.models = deepMerge(cfg.models || {}, modelsSetting);
  }

  if (context) {
    // keep reference only
  }
  return cfg;
}

/** Merge a patch into ~/.ollamacode/config.json (or override path). */
export function patchExternalConfig(patch: Record<string, unknown>): string {
  const configPath = defaultExternalConfigPath();
  const override = (vscode.workspace.getConfiguration("ollamaCode").get<string>("externalConfigPath") || "").trim();
  const p = override || configPath;
  let cur: Record<string, unknown> = {};
  try {
    if (fs.existsSync(p)) cur = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    cur = {};
  }
  const next = deepMerge(cur, patch);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2), "utf8");
  return p;
}

/** Persist Always Allow for a tool kind (file + VS Code settings). */
export function persistAutoApprove(kind: "read" | "write" | "terminal"): void {
  const key =
    kind === "read"
      ? "autoApproveRead"
      : kind === "write"
        ? "autoApproveWrite"
        : "autoApproveTerminal";
  patchExternalConfig({ tools: { [key]: true } });
  void vscode.workspace.getConfiguration("ollamaCode").update(key, true, true);
}

/** Resolve effective params for a specific Ollama model tag. */
export function resolveModelRuntime(modelName: string, cfg?: OllamaCodeConfig) {
  const c = cfg || loadConfig();
  const over = c.models?.[modelName] || c.models?.[modelName.replace(/:latest$/, "")] || {};
  return {
    systemPrompt: over.systemPrompt || c.chat.systemPrompt,
    temperature: over.temperature ?? c.ollama.temperature,
    numCtx: over.numCtx ?? c.ollama.numCtx,
    virtualCtx: over.virtualCtx ?? 32768,
    chunkedContext: over.chunkedContext !== false,
    hardwareProfile: (over.hardwareProfile || "medium") as HardwareProfile,
    thinking: (over.thinking || c.chat.thinking) as ThinkingMode,
    keepAlive: over.keepAlive || c.ollama.keepAlive,
    numGpu: over.numGpu,
    numThread: over.numThread,
    numBatch: over.numBatch,
    // Default unlimited — thinking + tools often eat a small num_predict budget
    numPredict: typeof over.numPredict === "number" && Number.isFinite(over.numPredict) ? over.numPredict : -1,
    topP: over.topP,
    topK: over.topK,
    repeatPenalty: over.repeatPenalty,
    seed: over.seed,
  };
}

/** Options object passed to Ollama /api/chat */
export function buildOllamaOptions(rt: ReturnType<typeof resolveModelRuntime>): Record<string, number> {
  const o: Record<string, number> = {
    temperature: rt.temperature,
    num_ctx: rt.numCtx,
    // Always send: omit → some Ollama builds use a tiny default and cut mid-sentence
    num_predict:
      typeof rt.numPredict === "number" && Number.isFinite(rt.numPredict) ? rt.numPredict : -1,
  };
  if (typeof rt.numGpu === "number" && Number.isFinite(rt.numGpu)) o.num_gpu = rt.numGpu;
  if (typeof rt.numThread === "number" && Number.isFinite(rt.numThread) && rt.numThread > 0) {
    o.num_thread = rt.numThread;
  }
  if (typeof rt.numBatch === "number" && Number.isFinite(rt.numBatch) && rt.numBatch > 0) {
    o.num_batch = rt.numBatch;
  }
  if (typeof rt.topP === "number" && Number.isFinite(rt.topP)) o.top_p = rt.topP;
  if (typeof rt.topK === "number" && Number.isFinite(rt.topK)) o.top_k = rt.topK;
  if (typeof rt.repeatPenalty === "number" && Number.isFinite(rt.repeatPenalty)) {
    o.repeat_penalty = rt.repeatPenalty;
  }
  if (typeof rt.seed === "number" && Number.isFinite(rt.seed) && rt.seed >= 0) o.seed = rt.seed;
  return o;
}
