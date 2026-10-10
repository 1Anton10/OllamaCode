import * as vscode from "vscode";
import { loadConfig, resolveModelRuntime, ThinkingMode, HardwareProfile } from "../config";
import { OllamaClient } from "../ollama/client";
import { fetchModelDefaults, ModelNativeDefaults } from "../ollama/modelDefaults";
import { resolveHardwareProfile } from "../ollama/hardwareProfiles";
import { persistModelOverrides, pushChipFromSettings } from "../agent/contextChipSync";

export type ModelSettingsRefresh = () => void;

/**
 * Modal webview: full per-model Ollama knobs with custom dropdowns.
 * Defaults come from the model (/api/show), overrides from ollamaCode.models.
 */
export class ModelSettingsPanel {
  public static current: ModelSettingsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private modelId: string;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    modelId: string,
    private readonly onSaved?: ModelSettingsRefresh
  ) {
    this.panel = panel;
    this.modelId = modelId;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => void this.onMessage(msg),
      null,
      this.disposables
    );
    this.render();
  }

  static show(modelId?: string, onSaved?: ModelSettingsRefresh): void {
    const cfg = loadConfig();
    const id = (typeof modelId === "string" && modelId) || cfg.ollama.defaultModel;

    if (ModelSettingsPanel.current) {
      ModelSettingsPanel.current.modelId = id;
      ModelSettingsPanel.current.render();
      ModelSettingsPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "ollamaCode.modelSettings",
      `Настройки · ${id}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );
    ModelSettingsPanel.current = new ModelSettingsPanel(panel, id, onSaved);
  }

  private dispose(): void {
    ModelSettingsPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private async onMessage(msg: any): Promise<void> {
    if (msg?.type === "ready") {
      await this.pushState();
      return;
    }
    if (msg?.type === "cancel") {
      this.panel.dispose();
      return;
    }
    if (msg?.type === "openFile") {
      await vscode.commands.executeCommand("ollamaCode.openExternalConfig");
      return;
    }
    if (msg?.type === "resetNative") {
      await this.pushState(true);
      return;
    }
    if (msg?.type === "save") {
      await this.save(msg);
      return;
    }
  }

  private async save(msg: Record<string, any>): Promise<void> {
    const id = this.modelId;
    const cur: Record<string, unknown> = {};

    if (typeof msg.systemPrompt === "string") cur.systemPrompt = msg.systemPrompt;
    if (msg.thinking === "auto" || msg.thinking === "on" || msg.thinking === "off") {
      cur.thinking = msg.thinking as ThinkingMode;
    }
    const setNum = (key: string, v: unknown) => {
      if (typeof v === "number" && Number.isFinite(v)) (cur as any)[key] = v;
    };
    // Knobs come from UI (preset buttons already expanded values client-side).
    setNum("numCtx", msg.numCtx);
    setNum("virtualCtx", msg.virtualCtx);
    setNum("temperature", msg.temperature);
    setNum("numGpu", msg.numGpu);
    setNum("numThread", msg.numThread);
    setNum("numBatch", msg.numBatch);
    setNum("numPredict", msg.numPredict);
    setNum("topP", msg.topP);
    setNum("topK", msg.topK);
    setNum("repeatPenalty", msg.repeatPenalty);
    setNum("seed", msg.seed);
    // Always keep chunked + virtual on unless user explicitly turned pack off
    cur.chunkedContext = msg.chunkedContext !== false;
    if (typeof cur.virtualCtx !== "number" || (cur.virtualCtx as number) < 32768) {
      if (msg.chunkedContext !== false) cur.virtualCtx = Math.max(32768, Number(msg.virtualCtx) || 32768);
    }
    if (typeof msg.keepAlive === "string" && msg.keepAlive.trim()) {
      cur.keepAlive = msg.keepAlive.trim();
    }
    if (msg.hardwareProfile === "light" || msg.hardwareProfile === "medium" || msg.hardwareProfile === "max") {
      cur.hardwareProfile = msg.hardwareProfile;
    }
    if (typeof msg.temperature === "number" && Number.isFinite(msg.temperature)) {
      cur.temperature = Math.min(2, Math.max(0, msg.temperature));
    }

    await persistModelOverrides(id, cur as any);
    await pushChipFromSettings(id, {
      numCtx: Number(cur.numCtx) || 8192,
      virtualCtx: Number(cur.virtualCtx) || 32768,
      chunkedContext: cur.chunkedContext !== false,
      thinking: (cur.thinking as ThinkingMode) || "auto",
    });
    this.onSaved?.();
    void vscode.window.showInformationMessage(
      `Сохранено для ${id} · чат-кнопка = ${cur.chunkedContext !== false ? cur.virtualCtx : cur.numCtx}`
    );
    this.panel.dispose();
  }

  private async pushState(forceNative = false): Promise<void> {
    const cfg = loadConfig();
    const rt = resolveModelRuntime(this.modelId, cfg);
    let native: ModelNativeDefaults | null = null;
    try {
      const client = new OllamaClient(cfg.ollama.baseUrl);
      native = await fetchModelDefaults(client, this.modelId);
    } catch {
      native = null;
    }

    const layerCount = native?.layerCount;
    const layerSource = native?.layerSource;
    // Prefer user override; else model default; else layerCount (all on GPU)
    const numGpu =
      forceNative && native?.numGpu !== undefined
        ? native.numGpu
        : rt.numGpu ?? native?.numGpu ?? layerCount;
    const numThread =
      forceNative && native?.numThread !== undefined
        ? native.numThread
        : rt.numThread ?? native?.numThread;
    const numCtx =
      forceNative && native?.numCtx !== undefined
        ? native.numCtx
        : rt.numCtx ?? native?.numCtx ?? 8192;
    const temperature =
      forceNative && native?.temperature !== undefined
        ? native.temperature
        : rt.temperature ?? native?.temperature ?? 0.3;

    const profile = (rt.hardwareProfile || "medium") as HardwareProfile;
    const profileResolved = resolveHardwareProfile(profile, layerCount);

    void this.panel.webview.postMessage({
      type: "state",
      modelId: this.modelId,
      systemPrompt: forceNative ? rt.systemPrompt : rt.systemPrompt,
      thinking: rt.thinking,
      hardwareProfile: profile,
      profileBlurb: profileResolved.blurb,
      virtualCtx: rt.virtualCtx ?? 32768,
      chunkedContext: rt.chunkedContext !== false,
      numCtx,
      temperature,
      keepAlive: forceNative ? native?.keepAlive || "30m" : rt.keepAlive || "30m",
      numGpu,
      numThread: numThread ?? 0,
      numBatch: forceNative ? native?.numBatch : rt.numBatch ?? native?.numBatch,
      numPredict: forceNative ? native?.numPredict : rt.numPredict ?? native?.numPredict,
      topP: forceNative ? native?.topP : rt.topP ?? native?.topP ?? 0.9,
      topK: forceNative ? native?.topK : rt.topK ?? native?.topK ?? 40,
      repeatPenalty:
        forceNative ? native?.repeatPenalty : rt.repeatPenalty ?? native?.repeatPenalty ?? 1.1,
      seed: forceNative ? native?.seed : rt.seed ?? native?.seed ?? -1,
      layerCount: layerCount ?? null,
      layerSource: layerSource || null,
      cpuRamLayers:
        layerCount !== undefined && numGpu !== undefined
          ? Math.max(0, layerCount - Math.min(layerCount, Math.max(0, numGpu)))
          : null,
      meta: {
        family: native?.family || "",
        parameterSize: native?.parameterSize || "",
        quantization: native?.quantization || "",
        hasNative: !!native,
      },
      ctxOptions: [2048, 4096, 8192, 16384, 32768, 65536, 131072],
      keepAliveOptions: [
        { v: "0", label: "0 (unload)" },
        { v: "5m", label: "5 минут" },
        { v: "15m", label: "15 минут" },
        { v: "30m", label: "30 минут" },
        { v: "1h", label: "1 час" },
        { v: "24h", label: "24 часа" },
        { v: "-1", label: "∞ forever" },
      ],
      threadOptions: [0, 2, 4, 6, 8, 12, 16, 24, 32],
    });
  }

  private render(): void {
    this.panel.title = `Настройки · ${this.modelId}`;
    this.panel.webview.html = this.html();
  }

  private html(): string {
    const csp = this.panel.webview.cspSource;
    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp} 'unsafe-inline';"/>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: var(--vscode-font-family);
    font-size: 13px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    min-height: 100vh;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 20px 16px 32px;
  }
  .modal {
    width: min(720px, 100%);
    border-radius: 14px;
    border: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
    background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
    box-shadow: 0 18px 48px rgba(0,0,0,.35);
    overflow: visible;
  }
  .head {
    padding: 16px 18px 12px;
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
  }
  .head h1 { margin: 0; font-size: 16px; font-weight: 600; }
  .head .sub { margin-top: 4px; opacity: .7; font-size: 12px; word-break: break-all; }
  .meta { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; }
  .pill {
    font-size: 11px;
    padding: 3px 9px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
    opacity: .85;
  }
  .body { padding: 16px 18px 8px; display: flex; flex-direction: column; gap: 16px; }
  .section-title {
    font-size: 11px;
    letter-spacing: .04em;
    text-transform: uppercase;
    opacity: .55;
    margin: 2px 0 0;
  }
  label { display: block; font-size: 12px; opacity: .8; margin-bottom: 6px; }
  textarea, input[type=number], input[type=text] {
    width: 100%;
    font: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, color-mix(in srgb, var(--vscode-foreground) 20%, transparent));
    border-radius: 10px;
    padding: 10px 12px;
    height: 34px;
  }
  textarea { min-height: 110px; height: auto; resize: vertical; line-height: 1.45; }
  textarea:focus, input:focus {
    outline: none;
    border-color: var(--vscode-focusBorder, #3794ff);
  }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  @media (max-width: 640px) {
    .grid2, .grid3 { grid-template-columns: 1fr; }
  }
  .seg {
    display: flex; gap: 6px; padding: 4px; border-radius: 10px;
    background: color-mix(in srgb, var(--vscode-editor-background) 85%, var(--vscode-foreground) 15%);
    border: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
  }
  .seg button {
    flex: 1; height: 30px; border: 1px solid transparent; border-radius: 8px;
    background: transparent; color: var(--vscode-foreground); cursor: pointer; font: inherit; opacity: .85;
  }
  .seg button.active {
    opacity: 1;
    background: color-mix(in srgb, var(--vscode-editor-background) 80%, var(--vscode-focusBorder, #3794ff) 20%);
    border-color: var(--vscode-focusBorder, #3794ff);
  }
  .hint { font-size: 11px; opacity: .55; margin-top: 5px; line-height: 1.35; }
  .layers-card, .preset-card {
    padding: 12px;
    border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
    background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  }
  .preset-card {
    border-color: color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 45%, transparent);
    background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-focusBorder, #3794ff) 18%);
  }
  .preset-card .seg button { height: 34px; font-weight: 600; }
  .bar {
    margin-top: 10px; height: 8px; border-radius: 999px; overflow: hidden;
    background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
    display: flex;
  }
  .bar .gpu { background: color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 80%, #22c55e); }
  .bar .cpu { background: color-mix(in srgb, var(--vscode-foreground) 35%, transparent); }
  .legend { display: flex; gap: 14px; margin-top: 8px; font-size: 11px; opacity: .75; }
  .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
  .legend .g { background: color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 80%, #22c55e); }
  .legend .c { background: color-mix(in srgb, var(--vscode-foreground) 45%, transparent); }

  .dd { position: relative; width: 100%; }
  .dd-btn {
    width: 100%; height: 34px; padding: 0 28px 0 12px; border-radius: 10px;
    border: 1px solid var(--vscode-input-border, color-mix(in srgb, var(--vscode-foreground) 20%, transparent));
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    cursor: pointer; text-align: left; font: inherit; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; position: relative;
  }
  .dd-btn::after {
    content: ''; position: absolute; right: 10px; top: 50%;
    width: 6px; height: 6px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
    transform: translateY(-65%) rotate(45deg); opacity: .7;
  }
  .dd.open .dd-btn { border-color: var(--vscode-focusBorder, #3794ff); }
  .dd-menu {
    display: none; position: absolute; z-index: 50; top: calc(100% + 4px); left: 0; right: 0;
    max-height: 240px; overflow: auto; border-radius: 10px;
    border: 1px solid var(--vscode-input-border, #555);
    background: var(--vscode-dropdown-background, var(--vscode-editor-background));
    box-shadow: 0 8px 24px rgba(0,0,0,.35); padding: 4px;
  }
  .dd.open .dd-menu { display: block; }
  .dd-item {
    display: block; width: 100%; text-align: left; border: none; background: transparent;
    color: var(--vscode-foreground); font: inherit; font-size: 13px; padding: 7px 10px;
    border-radius: 7px; cursor: pointer;
  }
  .dd-item:hover { background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 10%, transparent)); }
  .dd-item.selected { background: color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 22%, transparent); }

  .foot {
    display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap;
    padding: 12px 18px 16px;
    border-top: 1px solid color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
  }
  .btn {
    height: 34px; padding: 0 14px; border-radius: 10px; border: none; cursor: pointer; font: inherit;
  }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-ghost {
    background: transparent; color: var(--vscode-foreground);
    border: 1px solid color-mix(in srgb, var(--vscode-foreground) 22%, transparent);
  }
</style>
</head>
<body>
  <div class="modal" role="dialog" aria-labelledby="title">
    <div class="head">
      <h1 id="title">Настройки модели</h1>
      <div class="sub" id="modelId">…</div>
      <div class="meta" id="meta"></div>
    </div>
    <div class="body">
      <div>
        <label for="systemPrompt">System prompt</label>
        <textarea id="systemPrompt" placeholder="Инструкции для модели…"></textarea>
        <div class="hint">Переопределение для этой модели · иначе общий system prompt</div>
      </div>

      <div class="section-title">Режим</div>
      <div>
        <label>Thinking</label>
        <div class="seg" id="thinkingSeg">
          <button type="button" data-v="auto">auto</button>
          <button type="button" data-v="on">on</button>
          <button type="button" data-v="off">off</button>
        </div>
      </div>

      <div class="section-title">Умный пресет · размазка по GPU / RAM / CPU</div>
      <div class="preset-card" id="presetCard">
        <div class="seg" id="profileSeg">
          <button type="button" data-v="light">Light</button>
          <button type="button" data-v="medium">Medium</button>
          <button type="button" data-v="max">Max</button>
        </div>
        <div class="hint" id="profileBlurb">Light ≈ 20% GPU · Medium ≈ 50% · Max = все слои на GPU. Считает от block_count модели.</div>
        <div class="hint" id="layerSourceHint" style="margin-top:8px;opacity:.75"></div>
      </div>

      <div class="section-title">Контекст и сэмплинг</div>
      <div class="grid2">
        <div>
          <label>Context (num_ctx)</label>
          <div class="dd" id="ddCtx" data-key="numCtx"></div>
        </div>
        <div>
          <label>Keep alive</label>
          <div class="dd" id="ddKeep" data-key="keepAlive"></div>
        </div>
        <div>
          <label for="temperature">Temperature</label>
          <input id="temperature" type="number" min="0" max="2" step="0.05" />
        </div>
        <div>
          <label for="topP">Top P</label>
          <input id="topP" type="number" min="0" max="1" step="0.05" />
        </div>
        <div>
          <label for="topK">Top K</label>
          <input id="topK" type="number" min="0" max="200" step="1" />
        </div>
        <div>
          <label for="repeatPenalty">Repeat penalty</label>
          <input id="repeatPenalty" type="number" min="0.5" max="2" step="0.05" />
        </div>
      </div>

      <div class="section-title">Слои · GPU / CPU+RAM (+ disk mmap)</div>
      <div class="layers-card">
        <div class="grid3">
          <div>
            <label>Всего слоёв (модель)</label>
            <input id="layerTotal" type="text" readonly />
          </div>
          <div>
            <label>На GPU (num_gpu)</label>
            <div class="dd" id="ddGpu" data-key="numGpu"></div>
          </div>
          <div>
            <label>На CPU / RAM</label>
            <input id="cpuRam" type="text" readonly />
          </div>
        </div>
        <div class="bar" id="layerBar"><div class="gpu" id="barGpu" style="width:50%"></div><div class="cpu" id="barCpu" style="width:50%"></div></div>
        <div class="legend"><span><i class="g"></i>GPU VRAM</span><span><i class="c"></i>CPU / RAM / disk mmap</span></div>
        <div class="hint">В Ollama: слои на GPU (num_gpu), остаток — системная память; что не влезло — mmap с диска. Отдельного «только диск» нет.</div>
      </div>

      <div class="section-title">Чанковый контекст (виртуальный)</div>
      <div class="grid2">
        <div>
          <label>Virtual target</label>
          <div class="dd" id="ddVirt" data-key="virtualCtx"></div>
          <div class="hint">Цель 32k–1M = кнопка Context в чате. Физическое окно — num_ctx выше (слои/пресет).</div>
        </div>
        <div>
          <label>Chunked pack</label>
          <div class="seg" id="chunkSeg">
            <button type="button" data-v="on">on</button>
            <button type="button" data-v="off">off</button>
          </div>
        </div>
      </div>

      <div class="section-title">Железо</div>
      <div class="grid3">
        <div>
          <label>CPU threads (num_thread)</label>
          <div class="dd" id="ddThreads" data-key="numThread"></div>
          <div class="hint">0 = авто Ollama</div>
        </div>
        <div>
          <label for="numBatch">Batch (num_batch)</label>
          <input id="numBatch" type="number" min="1" max="2048" step="1" placeholder="default" />
        </div>
        <div>
          <label for="numPredict">Max tokens (num_predict)</label>
          <input id="numPredict" type="number" min="-1" max="128000" step="1" placeholder="-1 = unlimited" />
        </div>
      </div>
      <div class="grid2">
        <div>
          <label for="seed">Seed (−1 = random)</label>
          <input id="seed" type="number" step="1" />
        </div>
      </div>
    </div>
    <div class="foot">
      <button type="button" class="btn btn-ghost" id="resetNative">Из модели</button>
      <button type="button" class="btn btn-ghost" id="openFile">Открыть config</button>
      <button type="button" class="btn btn-ghost" id="cancel">Отмена</button>
      <button type="button" class="btn btn-primary" id="save">Сохранить</button>
    </div>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  let thinking = 'auto';
  let hardwareProfile = 'medium';
  let chunkedContext = true;
  let state = {};
  const ddValues = {};
  const PROFILE_APPLY = {
    light:  { numCtx: 32768, numBatch: 256, numPredict: -1, keepAlive: '5m',  frac: 0.2 },
    medium: { numCtx: 16384, numBatch: 256, numPredict: -1, keepAlive: '10m', frac: 0.7 },
    max:    { numCtx: 8192,  numBatch: 128, numPredict: -1, keepAlive: '30m', frac: 1.0 },
  };

  function setThinking(v) {
    thinking = v;
    [...document.getElementById('thinkingSeg').querySelectorAll('button')].forEach(b => {
      b.classList.toggle('active', b.dataset.v === v);
    });
  }
  document.getElementById('thinkingSeg').querySelectorAll('button').forEach(b => {
    b.onclick = () => setThinking(b.dataset.v);
  });

  function setProfile(v, applyKnobs) {
    hardwareProfile = v;
    [...document.getElementById('profileSeg').querySelectorAll('button')].forEach(b => {
      b.classList.toggle('active', b.dataset.v === v);
    });
    const p = PROFILE_APPLY[v];
    if (!p) return;
    if (applyKnobs) {
      const layers = state.layerCount || 40;
      const gpu = v === 'max' ? layers : Math.max(1, Math.round(layers * p.frac));
      ddValues.numCtx = p.numCtx;
      ddValues.numGpu = gpu;
      ddValues.keepAlive = p.keepAlive;
      document.getElementById('numBatch').value = String(p.numBatch);
      document.getElementById('numPredict').value = String(p.numPredict);
      // refresh dropdown labels
      const ctxBtn = document.querySelector('#ddCtx .dd-btn');
      if (ctxBtn) ctxBtn.textContent = Number(p.numCtx).toLocaleString('en-US');
      const gpuBtn = document.querySelector('#ddGpu .dd-btn');
      if (gpuBtn) {
        let label = String(gpu);
        if (gpu === 0) label = '0 · всё на CPU/RAM';
        if (gpu === layers) label = gpu + ' · всё на GPU';
        gpuBtn.textContent = label;
      }
      const keepBtn = document.querySelector('#ddKeep .dd-btn');
      if (keepBtn) keepBtn.textContent = p.keepAlive;
      updateLayerUi(gpu, layers);
    }
  }
  document.getElementById('profileSeg').querySelectorAll('button').forEach(b => {
    b.onclick = () => setProfile(b.dataset.v, true);
  });

  function setChunked(on) {
    chunkedContext = !!on;
    [...document.getElementById('chunkSeg').querySelectorAll('button')].forEach(b => {
      b.classList.toggle('active', (b.dataset.v === 'on') === chunkedContext);
    });
  }
  document.getElementById('chunkSeg').querySelectorAll('button').forEach(b => {
    b.onclick = () => setChunked(b.dataset.v === 'on');
  });

  function closeAllDd(except) {
    document.querySelectorAll('.dd.open').forEach(el => {
      if (el !== except) el.classList.remove('open');
    });
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.dd')) closeAllDd();
  });

  function mountDd(rootId, options, current, onChange) {
    const root = document.getElementById(rootId);
    const key = root.dataset.key;
    const cur = current;
    ddValues[key] = cur;
    const labelOf = (v) => {
      const o = options.find(x => String(x.v) === String(v));
      return o ? o.label : String(v);
    };
    root.innerHTML = '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd-btn';
    btn.textContent = labelOf(cur);
    const menu = document.createElement('div');
    menu.className = 'dd-menu';
    options.forEach(o => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'dd-item' + (String(o.v) === String(cur) ? ' selected' : '');
      item.textContent = o.label;
      item.onclick = (ev) => {
        ev.stopPropagation();
        ddValues[key] = o.v;
        btn.textContent = o.label;
        root.classList.remove('open');
        menu.querySelectorAll('.dd-item').forEach(x => x.classList.remove('selected'));
        item.classList.add('selected');
        onChange && onChange(o.v);
      };
      menu.appendChild(item);
    });
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const open = root.classList.contains('open');
      closeAllDd();
      if (!open) root.classList.add('open');
    };
    root.appendChild(btn);
    root.appendChild(menu);
  }

  function updateLayerUi(gpu, total) {
    const t = total || 0;
    const g = Math.max(0, Math.min(t || gpu || 0, gpu ?? 0));
    const cpu = t ? Math.max(0, t - g) : null;
    document.getElementById('layerTotal').value = t ? String(t) : 'неизвестно';
    document.getElementById('cpuRam').value = cpu === null ? '—' : String(cpu);
    const pctG = t ? Math.round((g / t) * 100) : 50;
    document.getElementById('barGpu').style.width = pctG + '%';
    document.getElementById('barCpu').style.width = (100 - pctG) + '%';
  }

  function applyState(msg) {
    state = msg;
    document.getElementById('modelId').textContent = msg.modelId;
    const meta = document.getElementById('meta');
    meta.innerHTML = '';
    const pills = [];
    if (msg.meta?.family) pills.push(msg.meta.family);
    if (msg.meta?.parameterSize) pills.push(msg.meta.parameterSize);
    if (msg.meta?.quantization) pills.push(msg.meta.quantization);
    if (msg.meta?.hasNative) pills.push('defaults из модели');
    else pills.push('Ollama offline — локальные defaults');
    if (msg.layerCount) pills.push(msg.layerCount + ' слоёв');
    if (msg.layerSource) pills.push(msg.layerSource);
    pills.forEach(t => {
      const s = document.createElement('span');
      s.className = 'pill';
      s.textContent = t;
      meta.appendChild(s);
    });

    document.getElementById('systemPrompt').value = msg.systemPrompt || '';
    setThinking(msg.thinking || 'auto');
    setProfile(msg.hardwareProfile || 'medium', false);
    document.getElementById('profileBlurb').textContent = msg.profileBlurb || '';
    const srcHint = document.getElementById('layerSourceHint');
    if (srcHint) {
      srcHint.textContent = msg.layerCount
        ? ('Парсинг: /api/show → model_info.' + (msg.layerSource || 'block_count') + ' = ' + msg.layerCount +
          ' · Light→' + Math.max(1, Math.round(msg.layerCount * 0.2)) +
          ' · Medium→' + Math.round(msg.layerCount * 0.5) +
          ' · Max→' + msg.layerCount + ' на GPU')
        : 'Слои не найдены в model_info — пресеты считают от fallback 40';
    }
    setChunked(msg.chunkedContext !== false);
    document.getElementById('temperature').value = String(msg.temperature ?? 0.3);
    document.getElementById('topP').value = String(msg.topP ?? 0.9);
    document.getElementById('topK').value = String(msg.topK ?? 40);
    document.getElementById('repeatPenalty').value = String(msg.repeatPenalty ?? 1.1);
    document.getElementById('seed').value = String(msg.seed ?? -1);
    document.getElementById('numBatch').value = msg.numBatch != null ? String(msg.numBatch) : '';
    document.getElementById('numPredict').value = msg.numPredict != null ? String(msg.numPredict) : '';

    const ctxOpts = (msg.ctxOptions || []).map(n => ({ v: n, label: n.toLocaleString('en-US') }));
    if (msg.numCtx && !ctxOpts.some(o => o.v === msg.numCtx)) {
      ctxOpts.unshift({ v: msg.numCtx, label: msg.numCtx.toLocaleString('en-US') + ' (модель)' });
    }
    mountDd('ddCtx', ctxOpts, msg.numCtx, null);

    const virtOpts = [8192, 16384, 32768, 65536, 131072, 1048576].map(n => ({
      v: n,
      label: n.toLocaleString('en-US') + (n >= 32768 ? (n >= 1048576 ? ' · ~1M' : ' · цель') : ''),
    }));
    if (msg.virtualCtx && !virtOpts.some(o => o.v === msg.virtualCtx)) {
      virtOpts.unshift({ v: msg.virtualCtx, label: String(msg.virtualCtx) });
    }
    mountDd('ddVirt', virtOpts, msg.virtualCtx || 32768, null);

    mountDd('ddKeep', msg.keepAliveOptions || [], msg.keepAlive || '30m', null);

    const layers = msg.layerCount || 0;
    const gpuOpts = [];
    if (layers > 0) {
      for (let i = 0; i <= layers; i++) {
        let label = String(i);
        if (i === 0) label = '0 · всё на CPU/RAM';
        if (i === layers) label = i + ' · всё на GPU';
        gpuOpts.push({ v: i, label });
      }
    } else {
      [0, 8, 16, 24, 32, 40, 48, 64, 80, 99].forEach(i => gpuOpts.push({ v: i, label: String(i) }));
    }
    const gpuCur = msg.numGpu != null ? msg.numGpu : layers;
    mountDd('ddGpu', gpuOpts, gpuCur, (v) => updateLayerUi(Number(v), layers));
    updateLayerUi(Number(gpuCur), layers);

    const thr = (msg.threadOptions || [0,4,8,16]).map(n => ({
      v: n,
      label: n === 0 ? '0 · auto' : String(n)
    }));
    mountDd('ddThreads', thr, msg.numThread ?? 0, null);
  }

  document.getElementById('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });
  document.getElementById('openFile').onclick = () => vscode.postMessage({ type: 'openFile' });
  document.getElementById('resetNative').onclick = () => vscode.postMessage({ type: 'resetNative' });
  document.getElementById('save').onclick = () => {
    const num = (id) => {
      const el = document.getElementById(id);
      if (!el || el.value === '') return null;
      const n = Number(el.value);
      return Number.isFinite(n) ? n : null;
    };
    vscode.postMessage({
      type: 'save',
      systemPrompt: document.getElementById('systemPrompt').value,
      thinking,
      hardwareProfile,
      chunkedContext,
      layerCount: state.layerCount || 0,
      numCtx: Number(ddValues.numCtx),
      virtualCtx: Number(ddValues.virtualCtx || 32768),
      keepAlive: String(ddValues.keepAlive || '30m'),
      temperature: num('temperature'),
      topP: num('topP'),
      topK: num('topK'),
      repeatPenalty: num('repeatPenalty'),
      seed: num('seed'),
      numGpu: Number(ddValues.numGpu),
      numThread: Number(ddValues.numThread),
      numBatch: num('numBatch'),
      numPredict: num('numPredict'),
    });
  };

  window.addEventListener('message', (ev) => {
    if (ev.data?.type === 'state') applyState(ev.data);
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
