import * as vscode from "vscode";
import { OllamaClient, RunningModel } from "./client";
import { loadConfig, resolveModelRuntime } from "../config";

function fmtBytes(n: number): string {
  if (!n || n <= 0) return "?";
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)}G`;
  const mb = n / 1024 ** 2;
  return `${mb.toFixed(0)}M`;
}

function shortName(name: string): string {
  return name.replace(/:latest$/, "").slice(0, 28);
}

function sameModel(a: string, b: string): boolean {
  const na = a.replace(/:latest$/, "").toLowerCase();
  const nb = b.replace(/:latest$/, "").toLowerCase();
  return na === nb || a.toLowerCase() === b.toLowerCase();
}

export class VramModelMonitor {
  private readonly client: OllamaClient;
  private readonly item: vscode.StatusBarItem;
  private timer?: NodeJS.Timeout;
  private switching = false;
  private lastActive = "";
  private cached: RunningModel[] = [];

  constructor() {
    const cfg = loadConfig();
    this.client = new OllamaClient(cfg.ollama.baseUrl);
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.item.command = "ollamaCode.vramMenu";
    this.item.tooltip = "Ollama VRAM — клик: выгрузить / сменить модель";
    this.item.show();
  }

  start(disposables: vscode.Disposable[]): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 4000);
    disposables.push(
      this.item,
      { dispose: () => this.stop() },
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("ollamaCode.defaultModel") ||
          e.affectsConfiguration("ollamaCode.baseUrl")
        ) {
          const cfg = loadConfig();
          this.client.setBaseUrl(cfg.ollama.baseUrl);
          const next = cfg.ollama.defaultModel;
          if (next && !sameModel(next, this.lastActive)) {
            void this.switchTo(next, { reason: "settings" });
          } else {
            void this.refresh();
          }
        }
      })
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  getRunning(): RunningModel[] {
    return this.cached;
  }

  async refresh(): Promise<void> {
    if (this.switching) return;
    const cfg = loadConfig();
    this.client.setBaseUrl(cfg.ollama.baseUrl);
    try {
      this.cached = await this.client.listRunning();
      this.render(this.cached, cfg.ollama.defaultModel);
    } catch {
      this.item.text = "$(debug-disconnect) Ollama offline";
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      this.cached = [];
    }
  }

  private render(running: RunningModel[], preferred: string): void {
    this.item.backgroundColor = undefined;
    if (!running.length) {
      this.item.text = `$(server) VRAM: пусто · ${shortName(preferred)}`;
      this.item.tooltip = "Нет моделей в VRAM. Клик — загрузить или сменить модель.";
      return;
    }
    const parts = running.map((m) => {
      const vram = fmtBytes(m.size_vram || m.size || 0);
      const mark = sameModel(m.name || m.model, preferred) ? "★" : "";
      return `${mark}${shortName(m.name || m.model)} ${vram}`;
    });
    this.item.text = `$(server) ${parts.join(" · ")}`;
    this.item.tooltip = new vscode.MarkdownString(
      `**Загружено в VRAM**\n\n` +
        running
          .map(
            (m) =>
              `- \`${m.name || m.model}\` — VRAM ${fmtBytes(m.size_vram || 0)} / size ${fmtBytes(m.size || 0)}`
          )
          .join("\n") +
        `\n\nКлик — выгрузить текущую или сменить модель.`
    );
  }

  /** Unload one resident model (keep_alive: 0). */
  async unloadOne(model: string): Promise<boolean> {
    if (this.switching) {
      void vscode.window.showWarningMessage("Сейчас идёт смена модели…");
      return false;
    }
    this.switching = true;
    const cfg = loadConfig();
    this.client.setBaseUrl(cfg.ollama.baseUrl);
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Ollama: unload ${shortName(model)}`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: "выгружаю из VRAM…" });
          this.item.text = `$(loading~spin) unload ${shortName(model)}`;
          await this.client.unloadModel(model);
        }
      );
      await this.refresh();
      void vscode.window.setStatusBarMessage(
        `$(check) ${shortName(model)} выгружена`,
        2500
      );
      return true;
    } catch (e: any) {
      void vscode.window.showErrorMessage(
        `Не удалось выгрузить ${model}: ${e?.message || e}`
      );
      await this.refresh();
      return false;
    } finally {
      this.switching = false;
    }
  }

  /** Unload every model currently in VRAM. */
  async unloadAll(): Promise<boolean> {
    if (this.switching) {
      void vscode.window.showWarningMessage("Сейчас идёт смена модели…");
      return false;
    }
    const running = [...this.cached];
    if (!running.length) {
      void vscode.window.showInformationMessage("VRAM уже пуст.");
      return true;
    }
    this.switching = true;
    const cfg = loadConfig();
    this.client.setBaseUrl(cfg.ollama.baseUrl);
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Ollama: unload VRAM",
          cancellable: false,
        },
        async (progress) => {
          for (const m of running) {
            const name = m.name || m.model;
            progress.report({ message: `выгружаю ${shortName(name)}…` });
            this.item.text = `$(loading~spin) unload ${shortName(name)}`;
            try {
              await this.client.unloadModel(name);
            } catch (e: any) {
              console.warn("unload failed", name, e?.message || e);
            }
          }
        }
      );
      await this.refresh();
      void vscode.window.setStatusBarMessage("$(check) VRAM очищен", 2500);
      return true;
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Unload: ${e?.message || e}`);
      await this.refresh();
      return false;
    } finally {
      this.switching = false;
    }
  }

  /**
   * Unload every other resident model, then warmup `model` with progress UI.
   */
  async switchTo(
    model: string,
    opts?: { reason?: string; keepOthers?: boolean }
  ): Promise<boolean> {
    if (this.switching) {
      void vscode.window.showWarningMessage("Смена модели уже идёт…");
      return false;
    }
    this.switching = true;
    const cfg = loadConfig();
    this.client.setBaseUrl(cfg.ollama.baseUrl);
    const rt = resolveModelRuntime(model, cfg);

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Ollama: ${shortName(model)}`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: "читаю VRAM…" });
          let running: RunningModel[] = [];
          try {
            running = await this.client.listRunning();
          } catch {
            running = [];
          }

          if (!opts?.keepOthers) {
            const toUnload = running.filter((m) => !sameModel(m.name || m.model, model));
            for (const m of toUnload) {
              const name = m.name || m.model;
              progress.report({ message: `выгружаю ${shortName(name)} из VRAM…` });
              this.item.text = `$(loading~spin) unload ${shortName(name)}`;
              try {
                await this.client.unloadModel(name);
              } catch (e: any) {
                console.warn("unload failed", name, e?.message || e);
              }
            }
          }

          const already = running.some((m) => sameModel(m.name || m.model, model));
          if (already && (opts?.keepOthers || running.length === 1)) {
            progress.report({ message: "уже в VRAM" });
          } else {
            progress.report({ message: `загружаю ${shortName(model)} в VRAM…` });
            this.item.text = `$(loading~spin) load ${shortName(model)}`;
            this.item.backgroundColor = new vscode.ThemeColor(
              "statusBarItem.warningBackground"
            );
            await this.client.warmupModel(model, {
              keepAlive: rt.keepAlive || "30m",
              numCtx: rt.numCtx,
            });
          }

          this.lastActive = model;
          progress.report({ message: "готово" });
        }
      );

      await this.refresh();
      void vscode.window.setStatusBarMessage(
        `$(check) ${shortName(model)} в VRAM`,
        2500
      );
      return true;
    } catch (e: any) {
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      void vscode.window.showErrorMessage(
        `Не удалось загрузить ${model}: ${e?.message || e}`
      );
      await this.refresh();
      return false;
    } finally {
      this.switching = false;
    }
  }
}

type VramMenuAction = "unload-current" | "unload-all" | "switch" | "refresh";

/** Status-bar click menu: unload current / all, or switch model. */
export async function showVramMenu(monitor: VramModelMonitor): Promise<void> {
  await monitor.refresh();
  const cfg = loadConfig();
  const running = monitor.getRunning();
  const preferred =
    running.find((m) => sameModel(m.name || m.model, cfg.ollama.defaultModel)) ||
    running[0];
  const preferredName = preferred ? preferred.name || preferred.model : "";

  type Item = vscode.QuickPickItem & { action: VramMenuAction; model?: string };
  const items: Item[] = [];

  if (preferredName) {
    items.push({
      label: `$(trash) Выгрузить текущую`,
      description: shortName(preferredName),
      detail: preferred
        ? `VRAM ${fmtBytes(preferred.size_vram || preferred.size || 0)}`
        : undefined,
      action: "unload-current",
      model: preferredName,
    });
  }

  if (running.length > 1) {
    items.push({
      label: "$(clear-all) Выгрузить все из VRAM",
      description: `${running.length} моделей`,
      action: "unload-all",
    });
  } else if (running.length === 1 && !preferredName) {
    items.push({
      label: "$(trash) Выгрузить из VRAM",
      description: shortName(running[0].name || running[0].model),
      action: "unload-current",
      model: running[0].name || running[0].model,
    });
  }

  // Per-model unload when several residents
  if (running.length > 1) {
    for (const m of running) {
      const name = m.name || m.model;
      items.push({
        label: `$(debug-disconnect) Выгрузить ${shortName(name)}`,
        description: fmtBytes(m.size_vram || m.size || 0),
        action: "unload-current",
        model: name,
      });
    }
  }

  items.push({
    label: "$(arrow-swap) Сменить / загрузить модель…",
    description: "unload других → load выбранной",
    action: "switch",
  });
  items.push({
    label: "$(refresh) Обновить статус VRAM",
    action: "refresh",
  });

  const pick = await vscode.window.showQuickPick(items, {
    title: "Ollama VRAM",
    placeHolder: running.length
      ? `В памяти: ${running.map((m) => shortName(m.name || m.model)).join(", ")}`
      : "VRAM пуст",
  });
  if (!pick) return;

  if (pick.action === "refresh") {
    await monitor.refresh();
    return;
  }
  if (pick.action === "unload-all") {
    await monitor.unloadAll();
    return;
  }
  if (pick.action === "unload-current" && pick.model) {
    await monitor.unloadOne(pick.model);
    return;
  }
  if (pick.action === "switch") {
    await pickAndSwitchModel(monitor);
  }
}

export async function pickAndSwitchModel(monitor: VramModelMonitor): Promise<void> {
  const cfg = loadConfig();
  const client = new OllamaClient(cfg.ollama.baseUrl);
  let models: { name: string }[] = [];
  try {
    models = await client.listModels();
  } catch (e: any) {
    void vscode.window.showErrorMessage(`Ollama: ${e?.message || e}`);
    return;
  }
  const running = monitor.getRunning();
  const runningSet = new Set(running.map((m) => (m.name || m.model).toLowerCase()));

  const items = models.map((m) => {
    const inVram = [...runningSet].some((r) => sameModel(r, m.name));
    const isDefault = sameModel(m.name, cfg.ollama.defaultModel);
    return {
      label: `${inVram ? "$(server) " : "$(circle-outline) "}${m.name}`,
      description: [
        inVram ? "в VRAM" : "на диске",
        isDefault ? "default" : "",
      ]
        .filter(Boolean)
        .join(" · "),
      name: m.name,
    };
  });

  const pick = await vscode.window.showQuickPick(items, {
    title: "Сменить Ollama-модель (unload старой → load новой)",
    placeHolder: "Любая локальная модель — tools работают у всех",
  });
  if (!pick) return;

  await vscode.workspace
    .getConfiguration("ollamaCode")
    .update("defaultModel", pick.name, vscode.ConfigurationTarget.Global);

  // also push utility model so chat picker follows
  try {
    await vscode.workspace.getConfiguration("chat").update(
      "utilityModel",
      { vendor: "ollamacode", id: pick.name },
      vscode.ConfigurationTarget.Global
    );
  } catch {
    /* ignore */
  }

  await monitor.switchTo(pick.name, { reason: "picker" });
}
