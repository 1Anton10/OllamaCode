import * as vscode from "vscode";
import { loadBundledCatalog, filterForModelView } from "../marketplace/catalog";
import { loadRegistry } from "../marketplace/registry";
import { MarketplaceService } from "../marketplace/installer";
import { evaluateFit, inferModelTags } from "../marketplace/modelMatch";
import { MarketplaceItem } from "../marketplace/types";
import { fetchRemoteCatalog, mergeCatalog } from "../marketplace/remoteSkills";
import { ensureWorkspaceTrustedForNetwork } from "../ollama/resolveModel";

export class SkillsHubProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "ollamaCode.skillsHub";
  private view?: vscode.WebviewView;
  private filterKind: string = "recommended";
  private search = "";
  private remoteItems: MarketplaceItem[] = [];
  private remoteNote = "";
  private remoteLoading = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly extensionPath: string,
    private readonly market: MarketplaceService
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.type) {
          case "ready":
            await this.ensureRemote(false);
            await this.pushState();
            break;
          case "refresh":
            await this.pushState();
            break;
          case "fetchRemote":
            await this.ensureRemote(true);
            await this.pushState();
            break;
          case "filter":
            this.filterKind = msg.kind || "recommended";
            this.search = msg.search || "";
            if (
              this.filterKind === "skill" ||
              this.filterKind === "rule" ||
              this.filterKind === "mcp" ||
              this.filterKind === "all"
            ) {
              await this.ensureRemote(false);
            }
            await this.pushState();
            break;
          case "install":
            await this.runAction(msg.id, "install");
            break;
          case "uninstall":
            await this.runAction(msg.id, "uninstall");
            break;
          case "toggle":
            await this.runAction(msg.id, "toggle");
            break;
          case "seed":
            await this.seedNow();
            break;
          case "openMcp":
            await vscode.commands.executeCommand("ollamaCode.openMcpConfig");
            break;
          case "openHf":
            await vscode.commands.executeCommand("ollamaCode.pullHfModel");
            break;
          default:
            console.warn("OllamaCode Hub unknown message", msg);
        }
      } catch (e: any) {
        void vscode.window.showErrorMessage(`OllamaCode Hub: ${e?.message || e}`);
        await this.pushState();
      }
    });
  }

  refresh(): void {
    void this.pushState();
  }

  private async ensureRemote(force: boolean): Promise<void> {
    if (this.remoteLoading) return;
    if (!force && this.remoteItems.length) return;
    if (force && !(await ensureWorkspaceTrustedForNetwork("скачка skills/MCP с GitHub/HF"))) {
      this.remoteNote = "Restricted Mode: доверь workspace, чтобы качать packs";
      await this.pushState();
      return;
    }
    this.remoteLoading = true;
    try {
      const res = await fetchRemoteCatalog({ force });
      this.remoteItems = res.items;
      const c = res.counts;
      const summary = `skills ${c.skill} · rules ${c.rule} · mcp ${c.mcp}`;
      this.remoteNote = res.error
        ? `Git/HF: ${res.error} (${summary})`
        : res.fromCache
          ? `Git/HF packs: ${summary} (кэш)`
          : `Git/HF packs: ${summary}`;
    } catch (e: any) {
      this.remoteNote = `Git/HF packs: ${e?.message || e}`;
    } finally {
      this.remoteLoading = false;
    }
  }

  private allItems(): MarketplaceItem[] {
    const bundled = loadBundledCatalog(this.extensionPath).items;
    return mergeCatalog(bundled, this.remoteItems);
  }

  private async seedNow(): Promise<void> {
    if (!(await ensureWorkspaceTrustedForNetwork("установку базовых skills"))) {
      this.remoteNote = "Restricted Mode: доверь workspace для установки skills";
      await this.pushState();
      return;
    }
    const catalog = loadBundledCatalog(this.extensionPath);
    await this.market.seedDefaults(catalog.items);
    await this.pushState();
    void vscode.window.showInformationMessage(
      "OllamaCode: базовый набор под текущую модель установлен"
    );
  }

  private async runAction(id: string, action: "install" | "uninstall" | "toggle"): Promise<void> {
    const item = this.allItems().find((i) => i.id === id);
    if (!item) return;
    if (
      action === "install" &&
      !(await ensureWorkspaceTrustedForNetwork(`установку «${item.name}»`))
    ) {
      this.remoteNote = "Restricted Mode: доверь workspace для установки";
      await this.pushState();
      return;
    }
    const model = this.market.getModelName();
    const fit = evaluateFit(item, model);
    if (action === "install" && fit.status === "conflict") {
      void vscode.window.showWarningMessage(
        `«${item.name}» не подходит для ${model}: ${fit.reason}`
      );
      return;
    }
    if (action === "install" && fit.status === "needs-env") {
      const ok = await vscode.window.showWarningMessage(
        `${item.name}: ${fit.reason}. Всё равно установить?`,
        "Установить"
      );
      if (ok !== "Установить") return;
    }
    try {
      if (action === "install") await this.market.install(item);
      else if (action === "uninstall") await this.market.uninstall(item);
      else {
        const reg = loadRegistry();
        const en = reg.items[id]?.enabled ?? false;
        if (!en && fit.status === "conflict") {
          void vscode.window.showWarningMessage(
            `Не включаю «${item.name}»: ${fit.reason}`
          );
          return;
        }
        await this.market.setEnabled(item, !en);
      }
      await this.pushState();
    } catch (e: any) {
      void vscode.window.showErrorMessage(`OllamaCode Hub: ${e?.message || e}`);
      await this.pushState();
    }
  }

  private async pushState(): Promise<void> {
    if (!this.view) return;
    const catalogItems = this.allItems();
    const reg = loadRegistry();
    const model = this.market.getModelName();
    const tags = inferModelTags(model);
    let items = filterForModelView(catalogItems, model, this.filterKind);
    if (this.filterKind === "conflicts") {
      items = catalogItems.filter(
        (i) =>
          evaluateFit(i, model).status === "conflict" &&
          !!reg.items[i.id]?.installed &&
          !!reg.items[i.id]?.enabled
      );
    }
    if (this.search.trim()) {
      const q = this.search.toLowerCase();
      items = items.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q) ||
          i.source.toLowerCase().includes(q)
      );
    }
    const active = catalogItems.filter((i) => reg.items[i.id]?.installed && reg.items[i.id]?.enabled);
    const inactive = catalogItems.filter((i) => reg.items[i.id]?.installed && !reg.items[i.id]?.enabled);
    // Only warn about incompatibility when the item is actually installed+enabled.
    // Catalog-only "don't install" hints for missing plugins/skills are noise.
    const conflicts = catalogItems
      .map((i) => ({ item: i, fit: evaluateFit(i, model) }))
      .filter(
        (x) =>
          x.fit.status === "conflict" &&
          !!reg.items[x.item.id]?.installed &&
          !!reg.items[x.item.id]?.enabled
      )
      .map((x) => ({
        id: x.item.id,
        name: x.item.name,
        kind: x.item.kind,
        reason: x.fit.reason,
        description: x.item.description,
        installed: true,
        enabled: true,
      }));
    const availableCount = items.filter((i) => !reg.items[i.id]?.installed && evaluateFit(i, model).status === "compatible").length;

    this.view.webview.postMessage({
      type: "state",
      model,
      modelTags: tags,
      filter: this.filterKind,
      remoteNote: this.remoteNote,
      remoteCount: this.remoteItems.length,
      items: items.map((i) => {
        const fit = evaluateFit(i, model);
        const installed = !!reg.items[i.id]?.installed;
        const enabled = !!reg.items[i.id]?.enabled;
        // Uninstalled incompatible items are just catalog entries — no conflict chrome
        const fitStatus =
          fit.status === "conflict" && !installed ? "compatible" : fit.status;
        return {
          ...i,
          fitStatus,
          fitReason: fitStatus === "conflict" ? fit.reason : fit.reason,
          status: !installed ? "available" : enabled ? "active" : "inactive",
        };
      }),
      activeCount: active.length,
      inactiveCount: inactive.length,
      conflictCount: conflicts.length,
      conflictHintCount: 0,
      conflicts,
      conflictHints: [],
      availableCount,
    });
  }

  private renderHtml(webview: vscode.Webview): string {
    const csp = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp} 'unsafe-inline';"/>
<style>
  html, body {
    margin: 0; padding: 0;
    font-family: var(--vscode-font-family);
    font-size: 13px;
    font-weight: var(--vscode-font-weight);
    color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }
  .header {
    padding: 12px 14px 10px;
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border, transparent));
  }
  .header .title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    opacity: 0.85;
    margin-bottom: 8px;
  }
  .model-line { font-size: 14px; line-height: 1.4; }
  .model-line code {
    font-family: var(--vscode-editor-font-family);
    font-size: 13px;
    padding: 2px 8px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--vscode-textLink-foreground) 14%, transparent);
    color: var(--vscode-textLink-foreground);
  }
  .muted { opacity: 0.72; font-size: 12.5px; margin-top: 4px; line-height: 1.35; }
  .stats {
    display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px;
    font-size: 12.5px;
  }
  .stat {
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    opacity: 0.95;
  }
  .stat.warn {
    background: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 22%, transparent);
    color: var(--vscode-errorForeground, #f14c4c);
    cursor: pointer;
    border: 1px solid color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 35%, transparent);
  }
  .stat.warn:hover { filter: brightness(1.08); }
  .stat.hidden { display: none; }
  .conflict-banner {
    display: none;
    margin: 10px 0 0;
    padding: 10px 12px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 28%, transparent);
  }
  .conflict-banner.visible { display: block; }
  .conflict-banner .cb-title {
    font-size: 13px; font-weight: 600; margin-bottom: 6px;
    color: var(--vscode-errorForeground, #f14c4c);
  }
  .conflict-banner .cb-item {
    font-size: 12.5px; line-height: 1.4; margin: 4px 0;
    opacity: 0.95;
  }
  .conflict-banner .cb-item strong { font-weight: 600; }
  .conflict-banner .cb-hint {
    margin-top: 8px; font-size: 12px; opacity: 0.75;
  }
  .toolbar {
    display: flex; flex-direction: column; gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
  }
  .filters { display: flex; flex-wrap: wrap; gap: 4px; }
  .filters button {
    font-family: inherit;
    font-size: 12px;
    padding: 5px 11px;
    margin: 0;
    border: none;
    border-radius: 999px;
    cursor: pointer;
    background: transparent;
    color: var(--vscode-foreground);
    opacity: 0.78;
  }
  .filters button:hover { background: var(--vscode-list-hoverBackground); opacity: 1; }
  .filters button.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
    opacity: 1;
  }
  input[type=search] {
    width: 100%; box-sizing: border-box;
    height: 30px;
    padding: 0 12px;
    font-family: inherit;
    font-size: 13.5px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 10px;
    outline: none;
  }
  input[type=search]:focus { border-color: var(--vscode-focusBorder); }
  .actions-bar { display: flex; flex-wrap: wrap; gap: 8px; }
  .actions-bar button, .row-actions button {
    font-family: inherit;
    font-size: 12.5px;
    min-height: 28px;
    padding: 0 14px;
    border: none;
    border-radius: 10px;
    cursor: pointer;
  }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-primary:disabled { opacity: 0.45; cursor: default; }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .section-label {
    padding: 12px 14px 6px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    opacity: 0.72;
  }
  .list { display: flex; flex-direction: column; gap: 8px; padding: 0 10px 14px; }
  .row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 6px 10px;
    padding: 12px 12px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
    border-radius: 12px;
    background: color-mix(in srgb, var(--vscode-editor-background) 55%, transparent);
    cursor: default;
  }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.conflict {
    border-color: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 35%, transparent);
    background: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 7%, transparent);
  }
  .row-title {
    font-size: 14px;
    font-weight: 500;
    display: flex; align-items: center; flex-wrap: wrap; gap: 7px;
  }
  .kind {
    font-size: 10.5px;
    text-transform: uppercase;
    opacity: 0.55;
    font-weight: 700;
    letter-spacing: 0.03em;
  }
  .state {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .state.active { background: var(--vscode-testing-iconPassed, #388a34); color: #fff; }
  .state.inactive { background: var(--vscode-editorWarning-foreground, #cca700); color: #000; }
  .state.conflict { background: var(--vscode-errorForeground, #f14c4c); color: #fff; }
  .row-desc {
    grid-column: 1 / -1;
    font-size: 13px;
    opacity: 0.82;
    line-height: 1.4;
  }
  .row-meta {
    grid-column: 1 / -1;
    font-size: 12px;
    opacity: 0.58;
    line-height: 1.35;
  }
  .row-actions {
    grid-column: 1 / -1;
    display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px;
  }
  .empty {
    padding: 20px 14px;
    opacity: 0.68;
    font-size: 13px;
    line-height: 1.4;
  }
</style>
</head>
<body>
  <div class="header">
    <div class="title">Под текущую модель</div>
    <div class="model-line">Модель: <code id="modelName">…</code></div>
    <div class="muted" id="modelTags"></div>
    <div class="stats">
      <span class="stat" id="sumActive">Активно: 0</span>
      <span class="stat" id="sumInactive">Выкл: 0</span>
      <span class="stat warn hidden" id="sumConflict" title="Показать конфликты">Конфликт: 0</span>
    </div>
    <div class="conflict-banner" id="conflictBanner">
      <div class="cb-title" id="conflictBannerTitle">Почему конфликт</div>
      <div id="conflictList"></div>
      <div class="cb-hint" id="conflictBannerHint">Эти пункты ломают или дублируют поведение текущей модели — ставить не нужно.</div>
      <div class="row-actions" id="conflictBannerActions" style="margin-top:8px"></div>
    </div>
  </div>
  <div class="toolbar">
    <input id="search" type="search" placeholder="Поиск MCP, skills, rules" />
    <div class="filters" id="filters"></div>
    <div class="actions-bar">
      <button class="btn-primary" id="seed">Поставить базовые</button>
      <button class="btn-secondary" id="openMcp">MCP.json</button>
      <button class="btn-secondary" id="fetchGit" title="Подтянуть skills / rules / MCP с GitHub и HF">Git / HF packs</button>
      <button class="btn-secondary" id="openHf" title="Модели Hugging Face → Ollama">HF models</button>
    </div>
    <div class="muted" id="remoteNote" style="margin-top:6px"></div>
  </div>
  <div class="section-label" id="sectionLabel">Каталог</div>
  <div class="muted" id="sectionHint" style="padding:0 10px 8px;font-size:11px"></div>
  <div class="list" id="list"></div>
<script>
  const vscode = acquireVsCodeApi();
  const filters = [
    { id: 'recommended', label: 'Для модели' },
    { id: 'mcp', label: 'MCP' },
    { id: 'skill', label: 'Skills' },
    { id: 'rule', label: 'Rules' },
    { id: 'link', label: 'Ссылки' },
    { id: 'conflicts', label: 'Конфликты' },
    { id: 'all', label: 'Все' },
  ];
  const filterEl = document.getElementById('filters');
  let currentFilter = 'recommended';
  function setFilter(id) {
    currentFilter = id;
    [...filterEl.children].forEach(c => c.classList.toggle('active', c.dataset.id === currentFilter));
    vscode.postMessage({ type: 'filter', kind: currentFilter, search: document.getElementById('search').value });
  }
  filters.forEach(f => {
    const b = document.createElement('button');
    b.textContent = f.label;
    b.dataset.id = f.id;
    if (f.id === currentFilter) b.classList.add('active');
    b.onclick = () => setFilter(f.id);
    filterEl.appendChild(b);
  });
  document.getElementById('search').oninput = (e) => {
    vscode.postMessage({ type: 'filter', kind: currentFilter, search: e.target.value });
  };
  document.getElementById('openMcp').onclick = () => vscode.postMessage({ type: 'openMcp' });
  document.getElementById('fetchGit').onclick = () => {
    document.getElementById('remoteNote').textContent = 'Загрузка packs с GitHub / Hugging Face…';
    vscode.postMessage({ type: 'fetchRemote' });
  };
  document.getElementById('openHf').onclick = () => vscode.postMessage({ type: 'openHf' });
  document.getElementById('seed').onclick = () => vscode.postMessage({ type: 'seed' });
  document.getElementById('sumConflict').onclick = () => setFilter('conflicts');

  const kindLabel = { mcp: 'MCP', skill: 'Skill', rule: 'Rule', link: 'Link' };
  const stateLabel = { available: 'доступно', active: 'вкл', inactive: 'выкл', conflict: 'конфликт' };
  const sectionTitles = {
    recommended: 'Лучшее под модель',
    mcp: 'MCP — установка и управление',
    skill: 'Skills — установка и управление',
    rule: 'Rules — установка и управление',
    link: 'Ссылки',
    conflicts: 'Конфликты (установленные)',
    all: 'Весь каталог (кнопка «Установить» = доступно)'
  };
  const sectionHints = {
    recommended: 'Здесь только рекомендованный минимум. Новые MCP/skills для загрузки — во вкладках MCP, Skills, Rules или Все.',
    mcp: 'Серверы MCP. У кого статус «доступно» — жми «Установить».',
    skill: 'Skills с GitHub + встроенные. «доступно» → «Установить».',
    rule: 'Правила агента. «доступно» → «Установить».',
    link: 'Внешние каталоги и доки (откроются в браузере).',
    conflicts: 'Установленные пункты, которые мешают текущей модели. Если пусто — конфликтов нет.',
    all: 'Builtin + GitHub (настройка ollamaCode.skillSources).'
  };

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type !== 'state') return;
    document.getElementById('modelName').textContent = msg.model;
    document.getElementById('modelTags').textContent = 'Теги: ' + (msg.modelTags || []).join(', ');
    document.getElementById('sumActive').textContent = 'Активно: ' + (msg.activeCount || 0);
    document.getElementById('sumInactive').textContent = 'Выкл: ' + (msg.inactiveCount || 0);
    const conflictEl = document.getElementById('sumConflict');
    const n = msg.conflictCount || 0;
    conflictEl.textContent = n > 0 ? ('Конфликт: ' + n) : 'Конфликт: 0';
    conflictEl.classList.toggle('hidden', n === 0);
    conflictEl.classList.toggle('warn', n > 0);
    const banner = document.getElementById('conflictBanner');
    const clist = document.getElementById('conflictList');
    const actions = document.getElementById('conflictBannerActions');
    const live = msg.conflicts || [];
    actions.innerHTML = '';
    if (live.length) {
      banner.classList.add('visible');
      document.getElementById('conflictBannerTitle').textContent = 'Нужно выключить';
      document.getElementById('conflictBannerHint').textContent = 'Эти пункты уже установлены и мешают текущей модели.';
      clist.innerHTML = live.map(c =>
        '<div class="cb-item"><strong>' + esc(c.name) + '</strong> — ' + esc(c.reason) + '</div>'
      ).join('');
      live.forEach(c => {
        const b = document.createElement('button');
        b.className = 'btn-primary';
        b.textContent = 'Выключить «' + c.name + '»';
        b.onclick = () => vscode.postMessage({ type: 'toggle', id: c.id });
        actions.appendChild(b);
      });
    } else {
      banner.classList.remove('visible');
      clist.innerHTML = '';
    }
    document.getElementById('sectionLabel').textContent = sectionTitles[msg.filter] || 'Каталог';
    document.getElementById('sectionHint').textContent = sectionHints[msg.filter] || '';
    const rn = document.getElementById('remoteNote');
    if (rn) rn.textContent = msg.remoteNote || '';
    const list = document.getElementById('list');
    list.innerHTML = '';
    const items = msg.items || [];
    if (!items.length) {
      list.innerHTML = '<div class="empty">Пусто в этом фильтре. Открой вкладку <b>MCP</b> / <b>Skills</b> / <b>Все</b> — там пункты со статусом «доступно» и кнопкой «Установить».</div>';
      return;
    }
    items.forEach(item => {
      const st = item.fitStatus === 'conflict' ? 'conflict' : (item.status || 'available');
      const row = document.createElement('div');
      row.className = 'row' + (item.fitStatus === 'conflict' ? ' conflict' : '');
      row.innerHTML =
        '<div class="row-title"><span class="kind">'+esc(kindLabel[item.kind]||item.kind)+'</span> '+
          esc(item.name)+' <span class="state '+st+'">'+(stateLabel[st]||st)+'</span></div>' +
        '<div></div>' +
        '<div class="row-desc">'+esc(item.description)+'</div>' +
        '<div class="row-meta">'+esc(item.fitReason || item.source)+
          (item.needsEnv ? ' · env: '+esc(item.needsEnv.join(', ')) : '')+'</div>' +
        '<div class="row-actions"></div>';
      const actions = row.querySelector('.row-actions');
      if (item.kind === 'link') {
        const b = document.createElement('button');
        b.className = 'btn-secondary';
        b.textContent = 'Открыть';
        b.onclick = () => vscode.postMessage({ type: 'install', id: item.id });
        actions.appendChild(b);
      } else if (item.status === 'available') {
        const b = document.createElement('button');
        b.className = 'btn-primary';
        b.textContent = item.fitStatus === 'conflict' ? 'Не подходит' : 'Установить';
        b.disabled = item.fitStatus === 'conflict';
        b.onclick = () => vscode.postMessage({ type: 'install', id: item.id });
        actions.appendChild(b);
      } else {
        const t = document.createElement('button');
        t.className = 'btn-secondary';
        t.textContent = item.status === 'active' ? 'Выключить' : 'Включить';
        t.onclick = () => vscode.postMessage({ type: 'toggle', id: item.id });
        actions.appendChild(t);
        const u = document.createElement('button');
        u.className = 'btn-secondary';
        u.textContent = 'Удалить';
        u.onclick = () => vscode.postMessage({ type: 'uninstall', id: item.id });
        actions.appendChild(u);
      }
      list.appendChild(row);
    });
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
