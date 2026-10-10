import * as path from "path";
import * as vscode from "vscode";
import { ensureExternalConfig, loadConfig } from "./config";
import { OllamaLanguageModelProvider } from "./ollama/lmProvider";
import { registerLegacyChatModels } from "./ollama/lmProviderLegacy";
import { registerAgentParticipant } from "./chatParticipant";
import { registerGenerateCommitMessage } from "./scm/generateCommitMessage";
import { interactivePullModel } from "./hf/catalog";
import { OllamaClient } from "./ollama/client";
import {
  applyOllamaOnlyPolicy,
  ensureApiModelsTemplate,
  openOllamaAgentChat,
} from "./policy/ollamaOnly";
import { SkillsHubProvider } from "./hub/SkillsHubProvider";
import { MarketplaceService } from "./marketplace/installer";
import { loadBundledCatalog } from "./marketplace/catalog";
import { seedDefaultMcpFromFile } from "./marketplace/mcpConfig";
import { userMcpJsonPath } from "./marketplace/paths";
import { LocalAccountsController } from "./accounts/controller";
import { ContextMeter, registerContextCommands } from "./agent/contextBudget";
import { initChatWorkspaceTransfer } from "./agent/chatWorkspaceTransfer";
import { ensureRepoMapWatcher } from "./index/repoMap";
import { registerNodeVersionTerminal } from "./terminal/nodeVersion";
import { VramModelMonitor, pickAndSwitchModel, showVramMenu } from "./ollama/vramMonitor";
import { registerBuiltinChatModes } from "./modes/builtinAgents";
import { ModelSettingsPanel } from "./ui/ModelSettingsPanel";
import { registerE2eCommands } from "./e2eSmoke";
import { registerOllamaLmTools } from "./tools/lmTools";
import { disposeAiTerminals } from "./tools/aiTerminal";
import * as fs from "fs";
import * as os from "os";

export async function activate(context: vscode.ExtensionContext) {
  // Drop legacy "AI: …" terminal tabs — agent uses native run_in_terminal
  try {
    disposeAiTerminals();
  } catch {
    /* ignore */
  }
  try {
    initChatWorkspaceTransfer(context.storageUri);
  } catch {
    /* ignore */
  }
  const provider = new OllamaLanguageModelProvider();
  let legacyRefresh: (() => Promise<void>) | undefined;
  const refreshAllModels = () => {
    provider.refresh();
    void legacyRefresh?.();
  };

  // Register LM provider FIRST — chat picker races activation otherwise.
  try {
    const lmAny = vscode.lm as any;
    if (typeof lmAny.registerLanguageModelChatProvider === "function") {
      context.subscriptions.push(lmAny.registerLanguageModelChatProvider("ollamacode", provider));
      console.info("[OllamaCode] registered LanguageModelChatProvider vendor=ollamacode");
      setTimeout(() => provider.refresh(), 400);
      setTimeout(() => provider.refresh(), 1500);
      setTimeout(() => provider.refresh(), 4000);
    } else if (typeof lmAny.registerChatModelProvider === "function") {
      const legacy = await registerLegacyChatModels(context);
      legacyRefresh = legacy.refresh;
      console.info("[OllamaCode] registered legacy ChatModelProvider");
    } else {
      void vscode.window.showWarningMessage(
        "OllamaCode: Language Model API недоступен в этой сборке"
      );
    }
  } catch (e: any) {
    console.warn("OllamaCode LM register:", e);
    void vscode.window.showWarningMessage(`OllamaCode LM: ${e?.message || e}`);
  }

  registerBuiltinChatModes(context);
  registerE2eCommands(context);
  try {
    registerOllamaLmTools(context);
  } catch (e) {
    console.warn("OllamaCode LM tools:", e);
  }

  const contextMeter = new ContextMeter();
  registerContextCommands(context, contextMeter);
  registerNodeVersionTerminal(context);
  registerGenerateCommitMessage(context);

  // Defer disk watchers / VRAM polling — they contend with EH boot on DEV
  setTimeout(() => {
    try {
      ensureRepoMapWatcher(context.subscriptions);
    } catch (e) {
      console.warn("OllamaCode repoMap:", e);
    }
  }, 5_000);

  const vram = new VramModelMonitor();
  setTimeout(() => {
    try {
      vram.start(context.subscriptions);
    } catch (e) {
      console.warn("OllamaCode vram:", e);
    }
  }, 3_000);
  context.subscriptions.push(
    vscode.commands.registerCommand("ollamaCode.vramMenu", () => showVramMenu(vram)),
    vscode.commands.registerCommand("ollamaCode.switchModel", () => pickAndSwitchModel(vram)),
    vscode.commands.registerCommand("ollamaCode.unloadModel", async () => {
      await vram.refresh();
      const cfg = loadConfig();
      const running = vram.getRunning();
      const cur =
        running.find((m) =>
          (m.name || m.model).replace(/:latest$/i, "").toLowerCase() ===
          cfg.ollama.defaultModel.replace(/:latest$/i, "").toLowerCase()
        ) || running[0];
      if (!cur) {
        void vscode.window.showInformationMessage("VRAM пуст — нечего выгружать.");
        return;
      }
      await vram.unloadOne(cur.name || cur.model);
    }),
    vscode.commands.registerCommand("ollamaCode.showVram", () => vram.refresh())
  );
  // Register chat commands FIRST so Ctrl+R / palette never hit "command not found"
  // even if later bootstrap throws.
  const market = new MarketplaceService(context.extensionPath);
  const hub = new SkillsHubProvider(context.extensionUri, context.extensionPath, market);
  const mcpDefaults = path.join(context.extensionPath, "..", "..", "config", "mcp.defaults.json");

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SkillsHubProvider.viewType, hub, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ollamaCode.defaultModel")) hub.refresh();
    }),
    vscode.commands.registerCommand("ollamaCode.openChat", async () => {
      await openOllamaAgentChat();
    }),
    vscode.commands.registerCommand("ollamaCode.openAgent", async () => {
      await openOllamaAgentChat();
    }),
    // User-initiated new window (agent must not spawn these — they hang when empty)
    vscode.commands.registerCommand("ollamaCode.openFolderNewWindow", async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Open in New Window",
        title: "Выбери папку для нового окна OllamaCode",
      });
      const folder = uris?.[0];
      if (!folder) return;
      try {
        await vscode.commands.executeCommand("vscode.openFolder", folder, {
          forceNewWindow: true,
        });
      } catch (e: any) {
        void vscode.window.showErrorMessage(
          `Не удалось открыть новое окно: ${e?.message || e}. Попробуй File → New Window, затем Open Folder.`
        );
      }
    }),
    vscode.commands.registerCommand("ollamaCode.openSkillsHub", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.ollamacode-hub");
    }),
    vscode.commands.registerCommand("ollamaCode.refreshSkillsHub", () => hub.refresh()),
    vscode.commands.registerCommand("ollamaCode.openMcpConfig", async () => {
      const p = userMcpJsonPath();
      try {
        seedDefaultMcpFromFile(mcpDefaults);
      } catch {
        /* ignore */
      }
      const doc = await vscode.workspace.openTextDocument(p);
      await vscode.window.showTextDocument(doc);
    }),
    vscode.commands.registerCommand("ollamaCode.applyOllamaOnlyPolicy", async () => {
      await applyOllamaOnlyPolicy(true);
      provider.refresh();
      void vscode.window.showInformationMessage(
        "OllamaCode: политика Ollama-only применена (локальные модели)"
      );
    }),
    vscode.commands.registerCommand("ollamaCode.refreshModels", () => {
      refreshAllModels();
      void vscode.window.showInformationMessage("OllamaCode: список моделей обновлён");
    }),
    vscode.commands.registerCommand("ollamaCode.pullHfModel", async () => {
      await interactivePullModel(() => refreshAllModels(), context.extensionUri);
    }),
    vscode.commands.registerCommand("ollamaCode.openApiModelsConfig", async () => {
      const p = await ensureApiModelsTemplate();
      const doc = await vscode.workspace.openTextDocument(p);
      await vscode.window.showTextDocument(doc);
      void vscode.window.showInformationMessage(
        "Облачные модели только через API (BYOK). Локальные — через Ollama."
      );
    }),
    vscode.commands.registerCommand("ollamaCode.verifyStack", async () => {
      const cfg = loadConfig();
      const client = new OllamaClient(cfg.ollama.baseUrl);
      const chatCfg = vscode.workspace.getConfiguration("chat");
      const lines: string[] = [];
      lines.push("# OllamaCode stack");
      try {
        const models = await client.listModels();
        lines.push(`✅ Ollama: ${cfg.ollama.baseUrl} (${models.length} models)`);
        for (const m of models) lines.push(`   - ${m.name}`);
      } catch (e: any) {
        lines.push(`❌ Ollama: ${e?.message || e}`);
      }
      try {
        const lm = await vscode.lm.selectChatModels({ vendor: "ollamacode" });
        lines.push(`✅ Chat provider ollamacode: ${lm.length} models`);
      } catch (e: any) {
        lines.push(`❌ LM provider: ${e?.message || e}`);
      }
      lines.push(`byokUtilityModelDefault: ${chatCfg.get("byokUtilityModelDefault")}`);
      lines.push(`utilityModel: ${JSON.stringify(chatCfg.get("utilityModel"))}`);
      lines.push(`default ollama model: ${cfg.ollama.defaultModel}`);
      const doc = await vscode.workspace.openTextDocument({
        content: lines.join("\n"),
        language: "markdown",
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand("ollamaCode.manageModels", async () => {
      const {
        probeOllama,
        installOllamaViaWingetOrBrowser,
        openOllamaDownloadPage,
        pickAndPullStarterModels,
        pullOllamaModel,
      } = await import("./onboard/ollamaSetup");
      const probe = await probeOllama();
      type Row = vscode.QuickPickItem & { id: string };
      const items: Row[] = [];
      if (!probe.ok && probe.reason === "unreachable") {
        items.push(
          {
            id: "install",
            label: "$(desktop-download) Установить Ollama",
            description: "winget / ollama.com",
            detail: probe.message,
          },
          {
            id: "site",
            label: "$(link-external) Открыть ollama.com/download",
            description: "официальный установщик",
          }
        );
      } else if (!probe.ok && probe.reason === "no_models") {
        items.push({
          id: "starters",
          label: "$(cloud-download) Выбрать стартовые модели",
          description: "qwen / llama / mistral / gemma",
          detail: probe.message,
        });
      } else if (probe.ok) {
        items.push({
          id: "starters",
          label: "$(symbol-misc) Добавить популярные модели",
          description: `${probe.models.length} уже установлено`,
        });
      }
      items.push(
        {
          id: "hf",
          label: "$(cloud-download) Browse Hugging Face (search + authors)",
          description: "парсинг HF API → скачать в Ollama",
        },
        {
          id: "pull",
          label: "$(add) Pull by Ollama tag / HF ref",
          description: "например hf.co/org/repo:Q4_K_M или llama3.2:3b",
        },
        { id: "refresh", label: "$(refresh) Refresh model list" },
        { id: "more", label: "$(gear) More provider settings…" }
      );
      const pick = await vscode.window.showQuickPick(items, {
        title: "OllamaCode — модели",
        placeHolder: probe.ok
          ? "Скачать модель или обновить список"
          : "Сначала установи Ollama / выбери модели",
        ignoreFocusOut: true,
      });
      if (!pick) return;
      if (pick.id === "install") {
        await installOllamaViaWingetOrBrowser();
        await pickAndPullStarterModels(() => refreshAllModels());
      } else if (pick.id === "site") {
        await openOllamaDownloadPage();
      } else if (pick.id === "starters") {
        await pickAndPullStarterModels(() => refreshAllModels());
      } else if (pick.id === "hf") {
        await vscode.commands.executeCommand("ollamaCode.pullHfModel");
      } else if (pick.id === "pull") {
        const ref = await vscode.window.showInputBox({
          prompt: "Ollama pull: тег или HF ref",
          placeHolder: "hf.co/huihui-ai/Qwen3.5-Abliterated:Q4_K_M",
          value: "hf.co/",
        });
        if (!ref?.trim()) return;
        await pullOllamaModel(ref.trim(), () => refreshAllModels());
      } else if (pick.id === "refresh") {
        provider.refresh();
        void vscode.window.showInformationMessage("Список моделей обновлён");
      } else if (pick.id === "more") {
        await vscode.commands.executeCommand("ollamaCode.manageProvider");
      }
    }),
    vscode.commands.registerCommand("ollamaCode.setupOllama", async () => {
      const { runOllamaOnboarding } = await import("./onboard/ollamaSetup");
      await runOllamaOnboarding(context, { force: true, onRefresh: () => refreshAllModels() });
    }),
    vscode.commands.registerCommand("ollamaCode.editModelSettings", async (modelId?: string) => {
      const cfg = loadConfig();
      const id = (typeof modelId === "string" && modelId) || cfg.ollama.defaultModel;
      ModelSettingsPanel.show(id, () => refreshAllModels());
    }),
    vscode.commands.registerCommand(
      "ollamaCode.syncFromChatModelConfiguration",
      async (args?: { modelId?: string; contextSize?: number; thinkingEffort?: string }) => {
        const { pullChipIntoSettings } = await import("./agent/contextChipSync");
        const id = (args?.modelId || loadConfig().ollama.defaultModel || "").replace(/^ollamacode\//, "");
        if (!id) return;
        await pullChipIntoSettings(id, {
          contextSize: args?.contextSize,
          thinkingEffort: args?.thinkingEffort,
        });
        provider.refresh();
      }
    ),
    vscode.commands.registerCommand("ollamaCode.enableChunkedContextDefaults", async () => {
      const { persistModelOverrides, pushChipFromSettings } = await import("./agent/contextChipSync");
      const cfg = loadConfig();
      const id = cfg.ollama.defaultModel;
      await persistModelOverrides(id, {
        chunkedContext: true,
        virtualCtx: 32768,
        numCtx: cfg.models?.[id]?.numCtx || cfg.ollama.numCtx || 8192,
        hardwareProfile: (cfg.models?.[id]?.hardwareProfile as any) || "medium",
        thinking: "auto",
      });
      await pushChipFromSettings(id, {
        numCtx: cfg.models?.[id]?.numCtx || 8192,
        virtualCtx: 32768,
        chunkedContext: true,
        thinking: "auto",
      });
      provider.refresh();
    }),
    vscode.commands.registerCommand("ollamaCode.manageProvider", async () => {
      const cfg = loadConfig();
      const pick = await vscode.window.showQuickPick(
        [
          { label: "$(package) Skills & MCP Hub", id: "hub" },
          { label: "$(cloud-download) Download from Hugging Face", id: "hf" },
          { label: "$(key) Cloud API models (BYOK)", id: "api" },
          { label: "$(shield) Apply Ollama-only policy", id: "policy" },
          { label: "$(refresh) Refresh models", id: "refresh" },
          { label: "$(verified) Verify stack", id: "verify" },
          { label: "$(gear) Open external config", id: "config" },
          { label: `Base URL: ${cfg.ollama.baseUrl}`, id: "url" },
          { label: `Default model: ${cfg.ollama.defaultModel}`, id: "model" },
          { label: `Thinking: ${cfg.chat.thinking}`, id: "think" },
        ],
        { title: "OllamaCode Provider" }
      );
      if (!pick) return;
      if (pick.id === "hub") await vscode.commands.executeCommand("ollamaCode.openSkillsHub");
      else if (pick.id === "hf") await vscode.commands.executeCommand("ollamaCode.pullHfModel");
      else if (pick.id === "api") await vscode.commands.executeCommand("ollamaCode.openApiModelsConfig");
      else if (pick.id === "policy") await vscode.commands.executeCommand("ollamaCode.applyOllamaOnlyPolicy");
      else if (pick.id === "config") await vscode.commands.executeCommand("ollamaCode.openExternalConfig");
      else if (pick.id === "refresh") provider.refresh();
      else if (pick.id === "verify") await vscode.commands.executeCommand("ollamaCode.verifyStack");
      else if (pick.id === "url") {
        const v = await vscode.window.showInputBox({ value: cfg.ollama.baseUrl, prompt: "Ollama base URL" });
        if (v) await vscode.workspace.getConfiguration("ollamaCode").update("baseUrl", v, true);
        provider.refresh();
      } else if (pick.id === "model") {
        const v = await vscode.window.showInputBox({
          value: cfg.ollama.defaultModel,
          prompt: "Default Ollama model",
        });
        if (v) await vscode.workspace.getConfiguration("ollamaCode").update("defaultModel", v, true);
        await applyOllamaOnlyPolicy(true);
      } else if (pick.id === "think") {
        const v = await vscode.window.showQuickPick(["auto", "on", "off"]);
        if (v) await vscode.workspace.getConfiguration("ollamaCode").update("thinking", v, true);
      }
    }),
    vscode.commands.registerCommand("ollamaCode.openExternalConfig", async () => {
      const cfg = loadConfig();
      const doc = await vscode.workspace.openTextDocument(cfg._configPath);
      await vscode.window.showTextDocument(doc);
    }),
    vscode.commands.registerCommand("ollamaCode.dev.reload", async () => {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    })
  );

  // (LM provider already registered at top of activate)

  // Dev hot-reload: only when OLLAMACODE_HOT=1 (avoids Reload Window storms during boot)
  if (process.env.OLLAMACODE_HOT === "1") {
    try {
      const trigger = path.join(os.homedir(), ".ollamacode", "reload.trigger");
      const dir = path.dirname(trigger);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(trigger)) fs.writeFileSync(trigger, "0\n", "utf8");
      const watcher = fs.watch(trigger, () => {
        void vscode.commands.executeCommand("workbench.action.reloadWindow");
      });
      context.subscriptions.push({ dispose: () => watcher.close() });
    } catch {
      /* ignore */
    }
  }

  // Register chat participant ASAP (no await) so host can finish handshake.
  const accounts = new LocalAccountsController();
  try {
    accounts.activate(context);
  } catch (e) {
    console.warn("OllamaCode accounts:", e);
  }

  try {
    registerAgentParticipant(context, {
      onChat: (title, preview) => accounts.recordChat(title, preview),
      contextMeter,
    });
  } catch (e) {
    console.warn("OllamaCode chat participant:", e);
  }

  // Everything else after a tick — never block activate()/EH ready signal.
  setTimeout(() => {
    void (async () => {
      try {
        await ensureExternalConfig();
        await ensureApiModelsTemplate(context.extensionPath);
        await applyOllamaOnlyPolicy(false);
        // Force chunked + virtual≥32k and sync chat Context chip
        await vscode.commands.executeCommand("ollamaCode.enableChunkedContextDefaults");
      } catch (e) {
        console.warn("OllamaCode bootstrap:", e);
      }
      try {
        seedDefaultMcpFromFile(mcpDefaults);
      } catch (e) {
        console.warn("OllamaCode mcp seed:", e);
      }
      try {
        const catalog = loadBundledCatalog(context.extensionPath);
        await market.seedDefaults(catalog.items);
        hub.refresh();
      } catch (e) {
        console.warn("OllamaCode marketplace seed:", e);
      }
    })();
  }, 0);

  // Policy refresh after UI is up (deferred — don't compete with first paint)
  setTimeout(() => {
    void applyOllamaOnlyPolicy(true).then(() => refreshAllModels());
  }, 20_000);

  const openOnStart =
    vscode.workspace.getConfiguration("ollamaCode").get<boolean>("openChatOnStartup", false) ||
    vscode.workspace.getConfiguration("ollamaCode").get<boolean>("openAgentOnStartup", false);
  // Empty New Window (no folder yet): don't fight the workbench with chat open
  const hasFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  if (openOnStart && hasFolder) {
    const delay = process.env.VSCODE_DEV === "1" ? 8_000 : 2_500;
    setTimeout(() => {
      void openOllamaAgentChat();
    }, delay);
  }

  // Fresh user: offer Install Ollama / starter models if stack is empty
  setTimeout(() => {
    void import("./onboard/ollamaSetup").then(({ runOllamaOnboarding }) =>
      runOllamaOnboarding(context, { onRefresh: () => refreshAllModels() })
    );
  }, process.env.VSCODE_DEV === "1" ? 25_000 : 15_000);
}

export function deactivate() {
  try {
    disposeAiTerminals();
  } catch {
    /* ignore */
  }
}
