import * as vscode from "vscode";
import { spawn } from "child_process";
import {
  authorsFromHits,
  HfModelHit,
  HfSort,
  listHfGgufFiles,
  POPULAR_AUTHORS,
  quantFromFilename,
  rankQuants,
  searchHfModels,
} from "./api";

export class HfBrowserPanel {
  public static current?: HfBrowserPanel;
  private readonly panel: vscode.WebviewPanel;
  private hits: HfModelHit[] = [];
  private query = "Qwen3 GGUF";
  private author = "";
  private sort: HfSort = "downloads";

  static open(
    extensionUri: vscode.Uri,
    onModelsChanged: () => void
  ): HfBrowserPanel {
    if (HfBrowserPanel.current) {
      HfBrowserPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      return HfBrowserPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "ollamaCode.hfBrowser",
      "Hugging Face → Ollama",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    HfBrowserPanel.current = new HfBrowserPanel(panel, extensionUri, onModelsChanged);
    return HfBrowserPanel.current;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly onModelsChanged: () => void
  ) {
    this.panel = panel;
    panel.webview.html = this.html();
    panel.onDidDispose(() => {
      if (HfBrowserPanel.current === this) HfBrowserPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          await this.search();
          break;
        case "search":
          this.query = String(msg.query || "");
          this.author = String(msg.author || "");
          this.sort = (msg.sort as HfSort) || "downloads";
          await this.search();
          break;
        case "download":
          await this.download(String(msg.id || ""));
          break;
        case "open":
          if (msg.id) {
            await vscode.env.openExternal(
              vscode.Uri.parse(`https://huggingface.co/${msg.id}`)
            );
          }
          break;
      }
    });
  }

  private async search(): Promise<void> {
    this.post({ type: "loading", value: true });
    try {
      this.hits = await searchHfModels({
        query: this.query,
        author: this.author || undefined,
        sort: this.sort,
        limit: 80,
        filter: "gguf",
      });
      const authors = [
        ...new Set([...POPULAR_AUTHORS, ...authorsFromHits(this.hits)]),
      ].sort((a, b) => a.localeCompare(b));
      this.post({
        type: "results",
        query: this.query,
        author: this.author,
        sort: this.sort,
        authors,
        popular: POPULAR_AUTHORS,
        items: this.hits,
      });
    } catch (e: any) {
      this.post({ type: "error", message: e?.message || String(e) });
      void vscode.window.showErrorMessage(`HF: ${e?.message || e}`);
    } finally {
      this.post({ type: "loading", value: false });
    }
  }

  private async download(repoId: string): Promise<void> {
    if (!repoId) return;
    this.post({ type: "status", message: `Читаю файлы ${repoId}…` });
    let files: string[];
    try {
      files = rankQuants(await listHfGgufFiles(repoId));
    } catch (e: any) {
      void vscode.window.showErrorMessage(e?.message || String(e));
      return;
    }
    if (!files.length) {
      void vscode.window.showWarningMessage("В репо нет .gguf");
      return;
    }
    const filePick = await vscode.window.showQuickPick(
      files.map((f) => ({
        label: f.split("/").pop()!,
        description: f,
        path: f,
      })),
      { title: `Квант для ${repoId}` }
    );
    if (!filePick) return;

    const channel = vscode.window.createOutputChannel("OllamaCode HF");
    channel.show(true);
    const log = (s: string) => channel.append(s.endsWith("\n") ? s : s + "\n");
    const quant = quantFromFilename(filePick.label);
    const ref = `hf.co/${repoId}:${quant}`;
    this.post({ type: "status", message: `ollama pull ${ref}…` });

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `ollama pull ${ref}`,
          cancellable: false,
        },
        async () => {
          await new Promise<void>((resolve, reject) => {
            const child = spawn("ollama", ["pull", ref], {
              shell: true,
              env: process.env,
              windowsHide: true,
            });
            child.stdout.on("data", (d) => log(d.toString()));
            child.stderr.on("data", (d) => log(d.toString()));
            child.on("close", (code) =>
              code === 0 ? resolve() : reject(new Error(`exit ${code}`))
            );
          });
        }
      );
      this.onModelsChanged();
      this.post({ type: "status", message: `Готово: ${ref}` });
      void vscode.window.showInformationMessage(`Скачано в Ollama: ${ref}`);
    } catch (e: any) {
      log(String(e?.message || e));
      this.post({ type: "status", message: `Ошибка: ${e?.message || e}` });
      void vscode.window.showErrorMessage(`Ошибка pull: ${e?.message || e}`);
    }
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
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
  body { font-family: var(--vscode-font-family); font-size: 14px; color: var(--vscode-foreground); margin: 0; padding: 16px; background: var(--vscode-editor-background); }
  h1 { font-size: 18px; margin: 0 0 8px; font-weight: 600; }
  .sub { opacity: .75; margin-bottom: 14px; font-size: 13px; line-height: 1.4; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; align-items: center; }
  input, button {
    font: inherit;
    padding: 0 14px;
    border-radius: 10px;
    border: 1px solid var(--vscode-input-border, #555);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    height: 34px;
    box-sizing: border-box;
  }
  input[type=search] { flex: 1; min-width: 180px; }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  button.secondary {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid color-mix(in srgb, var(--vscode-foreground) 22%, transparent);
  }
  button:disabled { opacity: .5; cursor: default; }
  .dd {
    position: relative;
    flex: 0 0 auto;
    min-width: 140px;
  }
  .dd-btn {
    width: 100%;
    height: 34px;
    padding: 0 28px 0 12px;
    border-radius: 10px;
    border: 1px solid var(--vscode-input-border, #555);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    cursor: pointer;
    text-align: left;
    font: inherit;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    position: relative;
  }
  .dd-btn::after {
    content: '';
    position: absolute;
    right: 10px;
    top: 50%;
    width: 6px;
    height: 6px;
    border-right: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor;
    transform: translateY(-65%) rotate(45deg);
    opacity: .7;
  }
  .dd.open .dd-btn {
    border-color: var(--vscode-focusBorder, #3794ff);
  }
  .dd-menu {
    display: none;
    position: absolute;
    z-index: 40;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    min-width: 180px;
    max-height: 260px;
    overflow: auto;
    border-radius: 10px;
    border: 1px solid var(--vscode-input-border, #555);
    background: var(--vscode-dropdown-background, var(--vscode-editor-background));
    box-shadow: 0 8px 24px rgba(0,0,0,.35);
    padding: 4px;
  }
  .dd.open .dd-menu { display: block; }
  .dd-item {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    background: transparent;
    color: var(--vscode-foreground);
    font: inherit;
    font-size: 13px;
    padding: 7px 10px;
    border-radius: 7px;
    cursor: pointer;
    height: auto;
  }
  .dd-item:hover {
    background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 10%, transparent));
  }
  .dd-item.selected {
    background: color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 22%, transparent);
  }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .chip {
    font-size: 12px;
    padding: 5px 12px;
    border-radius: 999px;
    cursor: pointer;
    color: var(--vscode-foreground);
    background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
    border: 1px solid color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
    opacity: 0.9;
  }
  .chip:hover {
    opacity: 1;
    background: color-mix(in srgb, var(--vscode-editor-background) 80%, var(--vscode-foreground) 20%);
  }
  .chip.active {
    opacity: 1;
    background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-focusBorder, #3794ff) 18%);
    border-color: var(--vscode-focusBorder, #3794ff);
    color: var(--vscode-foreground);
    box-shadow: none;
    outline: none;
  }
  .status { font-size: 13px; opacity: .8; margin-bottom: 10px; min-height: 1.2em; }
  .list { display: flex; flex-direction: column; gap: 10px; }
  .card { border: 1px solid var(--vscode-panel-border, #444); border-radius: 12px; padding: 14px; }
  .card h3 { margin: 0 0 6px; font-size: 14px; word-break: break-all; font-weight: 560; }
  .meta { font-size: 12px; opacity: .75; margin-bottom: 10px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .author { color: var(--vscode-textLink-foreground); }
  .empty { opacity: .7; padding: 20px; text-align: center; }
</style>
</head>
<body>
  <h1>Hugging Face GGUF → Ollama</h1>
  <div class="sub">Парсим HF API (filter=gguf), фильтр по автору, сортировка. Скачивание через <code>ollama pull hf.co/…</code></div>
  <div class="row">
    <input id="q" type="search" placeholder="Поиск: Qwen3.5, abliterated, coder…" />
    <div class="dd" id="ddAuthor" data-value="">
      <button type="button" class="dd-btn" id="authorBtn" title="Автор / org">Все авторы</button>
      <div class="dd-menu" id="authorMenu"></div>
    </div>
    <div class="dd" id="ddSort" data-value="downloads">
      <button type="button" class="dd-btn" id="sortBtn" title="Сортировка">↓ downloads</button>
      <div class="dd-menu" id="sortMenu"></div>
    </div>
    <button id="go">Искать</button>
  </div>
  <div class="chips" id="chips"></div>
  <div class="status" id="status"></div>
  <div class="list" id="list"></div>
<script>
  const vscode = acquireVsCodeApi();
  const q = document.getElementById('q');
  const list = document.getElementById('list');
  const status = document.getElementById('status');
  const chips = document.getElementById('chips');
  const ddAuthor = document.getElementById('ddAuthor');
  const ddSort = document.getElementById('ddSort');
  const authorBtn = document.getElementById('authorBtn');
  const sortBtn = document.getElementById('sortBtn');
  const authorMenu = document.getElementById('authorMenu');
  const sortMenu = document.getElementById('sortMenu');

  const SORT_OPTS = [
    { value: 'downloads', label: '↓ downloads' },
    { value: 'likes', label: '❤ likes' },
    { value: 'trending', label: '🔥 trending' },
    { value: 'modified', label: '🕒 modified' },
    { value: 'created', label: '🆕 created' },
  ];

  function closeAllDd(except) {
    [ddAuthor, ddSort].forEach(dd => {
      if (dd !== except) dd.classList.remove('open');
    });
  }

  function fillMenu(menu, options, selected, onPick) {
    menu.innerHTML = '';
    options.forEach(opt => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dd-item' + (opt.value === selected ? ' selected' : '');
      b.textContent = opt.label;
      b.onclick = (e) => {
        e.stopPropagation();
        onPick(opt.value, opt.label);
      };
      menu.appendChild(b);
    });
  }

  function setAuthor(value, label) {
    ddAuthor.dataset.value = value || '';
    authorBtn.textContent = label || 'Все авторы';
    ddAuthor.classList.remove('open');
  }

  function setSort(value, label) {
    const opt = SORT_OPTS.find(o => o.value === value) || SORT_OPTS[0];
    ddSort.dataset.value = opt.value;
    sortBtn.textContent = label || opt.label;
    ddSort.classList.remove('open');
  }

  function runSearch() {
    vscode.postMessage({
      type: 'search',
      query: q.value,
      author: ddAuthor.dataset.value || '',
      sort: ddSort.dataset.value || 'downloads',
    });
  }

  authorBtn.onclick = (e) => {
    e.stopPropagation();
    const open = !ddAuthor.classList.contains('open');
    closeAllDd();
    if (open) ddAuthor.classList.add('open');
  };
  sortBtn.onclick = (e) => {
    e.stopPropagation();
    const open = !ddSort.classList.contains('open');
    closeAllDd();
    if (open) {
      fillMenu(sortMenu, SORT_OPTS, ddSort.dataset.value, (v, l) => {
        setSort(v, l);
        runSearch();
      });
      ddSort.classList.add('open');
    }
  };
  document.addEventListener('click', () => closeAllDd());
  document.getElementById('go').onclick = runSearch;
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });

  fillMenu(sortMenu, SORT_OPTS, 'downloads', (v, l) => {
    setSort(v, l);
    runSearch();
  });

  function fmt(n) {
    if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n/1e3).toFixed(1) + 'k';
    return String(n);
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type === 'loading') {
      status.textContent = msg.value ? 'Загрузка с huggingface.co…' : status.textContent;
      return;
    }
    if (msg.type === 'status') { status.textContent = msg.message || ''; return; }
    if (msg.type === 'error') { status.textContent = 'Ошибка: ' + msg.message; return; }
    if (msg.type !== 'results') return;

    q.value = msg.query || '';
    setSort(msg.sort || 'downloads');
    const authors = msg.authors || [];
    const cur = msg.author || '';
    const authorOpts = [{ value: '', label: 'Все авторы' }].concat(
      authors.map(a => ({ value: a, label: a }))
    );
    setAuthor(cur, cur || 'Все авторы');
    fillMenu(authorMenu, authorOpts, cur, (v, l) => {
      setAuthor(v, l);
      runSearch();
    });

    chips.innerHTML = '';
    (msg.popular || []).forEach(a => {
      const el = document.createElement('span');
      el.className = 'chip' + (a === cur ? ' active' : '');
      el.textContent = a;
      el.onclick = () => { setAuthor(a, a); runSearch(); };
      chips.appendChild(el);
    });
    const all = document.createElement('span');
    all.className = 'chip' + (!cur ? ' active' : '');
    all.textContent = 'Все';
    all.onclick = () => { setAuthor('', 'Все авторы'); runSearch(); };
    chips.prepend(all);

    const items = msg.items || [];
    status.textContent = items.length + ' моделей GGUF';
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<div class="empty">Ничего не найдено. Смени запрос или автора.</div>';
      return;
    }
    items.forEach(item => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<h3><span class="author">'+item.author+'</span>/'+item.name+'</h3>' +
        '<div class="meta">↓ '+fmt(item.downloads)+' · ❤ '+fmt(item.likes)+
          (item.pipeline_tag ? ' · '+item.pipeline_tag : '')+'</div>' +
        '<div class="actions"></div>';
      const actions = card.querySelector('.actions');
      const dl = document.createElement('button');
      dl.textContent = 'Скачать в Ollama';
      dl.onclick = () => vscode.postMessage({ type: 'download', id: item.id });
      const open = document.createElement('button');
      open.className = 'secondary';
      open.textContent = 'Открыть на HF';
      open.onclick = () => vscode.postMessage({ type: 'open', id: item.id });
      actions.appendChild(dl);
      actions.appendChild(open);
      list.appendChild(card);
    });
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

