import * as vscode from "vscode";
import { OllamaClient, ChatMessage } from "../ollama/client";
import { OllamaCodeConfig } from "../config";
import { runAgentTurn } from "../agent/loop";
import { detectCapabilities, resolveThinking } from "../ollama/capabilities";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "ollamaCode.chatView";
  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private busy = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext,
    private readonly ollama: OllamaClient,
    private readonly getConfig: () => OllamaCodeConfig
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.html(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          await this.pushModels();
          this.post({ type: "config", config: this.publicConfig() });
          break;
        case "refreshModels":
          await this.pushModels();
          break;
        case "newChat":
          this.newChat();
          break;
        case "send":
          await this.handleSend(msg.text, msg.model, msg.thinking);
          break;
        case "openConfig":
          await vscode.commands.executeCommand("ollamaCode.openExternalConfig");
          break;
      }
    });
  }

  newChat() {
    this.history = [];
    this.post({ type: "cleared" });
  }

  async refreshModels() {
    await this.pushModels();
  }

  private publicConfig() {
    const c = this.getConfig();
    return {
      defaultModel: c.ollama.defaultModel,
      thinking: c.chat.thinking,
      baseUrl: c.ollama.baseUrl,
      title: c.ui.title,
      showThinking: c.ui.showThinking,
    };
  }

  private post(payload: any) {
    this.view?.webview.postMessage(payload);
  }

  private async pushModels() {
    const cfg = this.getConfig();
    this.ollama.setBaseUrl(cfg.ollama.baseUrl);
    try {
      const models = await this.ollama.listModels();
      const enriched = [];
      for (const m of models) {
        const caps = await detectCapabilities(this.ollama, m.name);
        const th = resolveThinking(cfg.chat.thinking, caps);
        enriched.push({
          name: m.name,
          supportsThinking: caps.supportsThinking,
          thinkingEnabled: th.enabled,
          thinkingNote: th.note,
        });
      }
      this.post({ type: "models", models: enriched, defaultModel: cfg.ollama.defaultModel });
    } catch (e: any) {
      this.post({ type: "error", text: `Ollama недоступен: ${e?.message || e}` });
    }
  }

  private async handleSend(text: string, model?: string, thinkingOverride?: string) {
    if (this.busy) return;
    const cfg = this.getConfig();
    if (thinkingOverride === "on" || thinkingOverride === "off" || thinkingOverride === "auto") {
      cfg.chat.thinking = thinkingOverride;
    }
    const useModel = model || cfg.ollama.defaultModel;
    this.ollama.setBaseUrl(cfg.ollama.baseUrl);
    this.busy = true;
    this.post({ type: "user", text });
    this.post({ type: "status", text: "думаю..." });

    try {
      this.history = await runAgentTurn({
        client: this.ollama,
        cfg,
        model: useModel,
        history: this.history,
        userText: text,
        onProgress: (p) => this.post(p),
      });
    } catch (e: any) {
      this.post({ type: "error", text: String(e?.message || e) });
    } finally {
      this.busy = false;
      this.post({ type: "idle" });
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = String(Date.now());
    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>OllamaCode Chat</title>
<style>
  :root {
    --bg: var(--vscode-sideBar-background);
    --fg: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border, #333);
    --input: var(--vscode-input-background);
    --accent: var(--vscode-button-background);
    --accentFg: var(--vscode-button-foreground);
    --card: color-mix(in srgb, var(--bg) 86%, #7dd3fc 14%);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--fg);
    background: radial-gradient(1200px 500px at 0% -10%, color-mix(in srgb, #38bdf8 18%, transparent), transparent), var(--bg);
    display: flex; flex-direction: column;
  }
  header {
    padding: 10px 12px 8px;
    border-bottom: 1px solid var(--border);
    display: grid; gap: 8px;
  }
  .row { display: flex; gap: 8px; align-items: center; }
  select, button, textarea {
    background: var(--input); color: var(--fg);
    border: 1px solid var(--border); border-radius: 8px;
    font: inherit;
  }
  select, button { padding: 6px 10px; }
  button { background: var(--accent); color: var(--accentFg); cursor: pointer; }
  button.ghost { background: transparent; color: var(--fg); }
  #messages { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .msg { padding: 10px 12px; border-radius: 12px; border: 1px solid var(--border); line-height: 1.45; white-space: pre-wrap; }
  .user { align-self: flex-end; background: color-mix(in srgb, var(--accent) 35%, var(--bg)); max-width: 92%; }
  .assistant { align-self: stretch; background: color-mix(in srgb, var(--bg) 92%, #fff 8%); }
  .thinking { opacity: 0.75; font-size: 12px; border-style: dashed; }
  .tool, .tool_result, .status { font-size: 12px; color: var(--muted); }
  .error { color: #fca5a5; border-color: #7f1d1d; }
  footer { border-top: 1px solid var(--border); padding: 10px; display: grid; gap: 8px; }
  textarea { width: 100%; min-height: 72px; resize: vertical; padding: 10px; }
  .hint { font-size: 11px; color: var(--muted); }
  #title { font-weight: 650; letter-spacing: 0.2px; }
</style>
</head>
<body>
  <header>
    <div class="row">
      <div id="title">OllamaCode</div>
      <div style="flex:1"></div>
      <button class="ghost" id="btnConfig" title="Внешний конфиг">⚙</button>
      <button class="ghost" id="btnNew" title="Новый чат">＋</button>
      <button class="ghost" id="btnRefresh" title="Обновить модели">↻</button>
    </div>
    <div class="row">
      <select id="model" style="flex:1"></select>
      <select id="thinking" title="Thinking">
        <option value="auto">think:auto</option>
        <option value="on">think:on</option>
        <option value="off">think:off</option>
      </select>
    </div>
    <div class="hint" id="capHint">подключение к Ollama...</div>
  </header>
  <div id="messages"></div>
  <footer>
    <textarea id="input" placeholder="Спроси агента… (Enter отправить, Shift+Enter — новая строка)"></textarea>
    <div class="row">
      <div class="hint" id="status">готово</div>
      <div style="flex:1"></div>
      <button id="btnSend">Отправить</button>
    </div>
  </footer>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const messages = document.getElementById('messages');
const modelEl = document.getElementById('model');
const thinkingEl = document.getElementById('thinking');
const input = document.getElementById('input');
const statusEl = document.getElementById('status');
const capHint = document.getElementById('capHint');
let currentAssistant = null;
let currentThinking = null;

function add(cls, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.textContent = text || '';
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
  return el;
}

function setModels(models, defaultModel) {
  modelEl.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.name;
    opt.textContent = m.name + (m.supportsThinking ? ' · think' : '');
    opt.dataset.note = m.thinkingNote || '';
    modelEl.appendChild(opt);
  }
  if (defaultModel) modelEl.value = defaultModel;
  updateCap();
}

function updateCap() {
  const opt = modelEl.selectedOptions[0];
  capHint.textContent = opt?.dataset?.note || '';
}

modelEl.addEventListener('change', updateCap);
document.getElementById('btnSend').onclick = send;
document.getElementById('btnNew').onclick = () => vscode.postMessage({ type: 'newChat' });
document.getElementById('btnRefresh').onclick = () => vscode.postMessage({ type: 'refreshModels' });
document.getElementById('btnConfig').onclick = () => vscode.postMessage({ type: 'openConfig' });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

function send() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  currentAssistant = null;
  currentThinking = null;
  vscode.postMessage({ type: 'send', text, model: modelEl.value, thinking: thinkingEl.value });
}

window.addEventListener('message', (event) => {
  const m = event.data;
  switch (m.type) {
    case 'models': setModels(m.models || [], m.defaultModel); break;
    case 'config':
      document.getElementById('title').textContent = m.config?.title || 'OllamaCode';
      if (m.config?.thinking) thinkingEl.value = m.config.thinking;
      break;
    case 'user': add('user', m.text); break;
    case 'cleared': messages.innerHTML = ''; currentAssistant = null; currentThinking = null; break;
    case 'status': statusEl.textContent = m.text || ''; if (m.thinkingNote) capHint.textContent = m.thinkingNote; break;
    case 'thinking':
      if (!currentThinking) currentThinking = add('thinking', '');
      currentThinking.textContent = 'thinking:\\n' + (m.text || '');
      break;
    case 'assistant':
      if (!currentAssistant) currentAssistant = add('assistant', '');
      currentAssistant.textContent = m.text || '';
      break;
    case 'tool': add('tool', '⚙ ' + (m.text || m.tool?.name || 'tool')); break;
    case 'tool_result': add('tool_result', '↳ ' + (m.text || '').slice(0, 1500)); break;
    case 'done':
      if (currentAssistant) currentAssistant.textContent = m.text || currentAssistant.textContent;
      else add('assistant', m.text || '');
      currentAssistant = null; currentThinking = null;
      break;
    case 'error': add('error', m.text || 'error'); break;
    case 'idle': statusEl.textContent = 'готово'; currentAssistant = null; currentThinking = null; break;
  }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
