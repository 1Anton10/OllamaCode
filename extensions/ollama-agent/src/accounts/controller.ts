import * as vscode from "vscode";
import {
  createAccount,
  deleteAccount,
  ensureDefaultAccount,
  getActiveAccount,
  listAccounts,
  loadAccount,
  renameAccount,
  switchAccount,
  touchRepo,
  touchWorkspace,
  upsertChat,
  LocalAccount,
} from "./store";

const PROVIDER_ID = "ollamacode";

export class LocalAccountAuthProvider implements vscode.AuthenticationProvider {
  private readonly _onDidChange =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this._onDidChange.event;

  async getSessions(_scopes?: readonly string[]): Promise<vscode.AuthenticationSession[]> {
    const acc = getActiveAccount() || ensureDefaultAccount();
    return [this.toSession(acc)];
  }

  async createSession(_scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
    const name = await vscode.window.showInputBox({
      prompt: "Имя локального аккаунта",
      placeHolder: "например: work, home, client-x",
      value: "",
    });
    if (!name?.trim()) {
      // cancel → ensure at least default exists
      const acc = ensureDefaultAccount();
      return this.toSession(acc);
    }
    const acc = createAccount(name.trim());
    this._onDidChange.fire({ added: [this.toSession(acc)], removed: [], changed: [] });
    return this.toSession(acc);
  }

  async removeSession(sessionId: string): Promise<void> {
    const all = listAccounts();
    if (all.length <= 1) {
      void vscode.window.showWarningMessage("Нельзя удалить последний локальный аккаунт");
      return;
    }
    deleteAccount(sessionId);
    const next = getActiveAccount() || ensureDefaultAccount();
    this._onDidChange.fire({
      added: [],
      removed: [{ id: sessionId, accessToken: "", account: { id: sessionId, label: sessionId }, scopes: [] }],
      changed: [this.toSession(next)],
    });
  }

  notifyChanged(changed?: LocalAccount): void {
    const acc = changed || getActiveAccount() || ensureDefaultAccount();
    this._onDidChange.fire({ added: [], removed: [], changed: [this.toSession(acc)] });
  }

  private toSession(acc: LocalAccount): vscode.AuthenticationSession {
    return {
      id: acc.id,
      accessToken: `local:${acc.id}`,
      account: { id: acc.id, label: acc.name },
      scopes: ["local"],
    };
  }
}

export class LocalAccountsController {
  private status?: vscode.StatusBarItem;
  readonly auth = new LocalAccountAuthProvider();

  activate(context: vscode.ExtensionContext): void {
    ensureDefaultAccount();
    this.syncWorkspaceIntoActive();

    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.status.command = "ollamaCode.accounts.menu";
    this.refreshStatus();
    this.status.show();

    context.subscriptions.push(
      this.status,
      vscode.authentication.registerAuthenticationProvider(PROVIDER_ID, "OllamaCode Local", this.auth, {
        supportsMultipleAccounts: true,
      }),
      vscode.commands.registerCommand("ollamaCode.accounts.menu", () => this.openMenu()),
      vscode.commands.registerCommand("ollamaCode.accounts.switch", () => this.switchFlow()),
      vscode.commands.registerCommand("ollamaCode.accounts.create", () => this.createFlow()),
      vscode.commands.registerCommand("ollamaCode.accounts.rename", () => this.renameFlow()),
      vscode.commands.registerCommand("ollamaCode.accounts.delete", () => this.deleteFlow()),
      vscode.commands.registerCommand("ollamaCode.accounts.showData", () => this.showData()),
      vscode.commands.registerCommand("ollamaCode.accounts.recordChat", (title?: string, preview?: string) => {
        this.recordChat(title || "Chat", preview);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.syncWorkspaceIntoActive())
    );

    // Keep a signed-in local session visible in Accounts menu
    void vscode.authentication.getSession(PROVIDER_ID, ["local"], { createIfNone: false }).then(async (s) => {
      if (!s) {
        try {
          await vscode.authentication.getSession(PROVIDER_ID, ["local"], {
            createIfNone: true,
          });
        } catch {
          /* user cancelled */
        }
      }
      this.refreshStatus();
    });
  }

  private refreshStatus(): void {
    const acc = getActiveAccount() || ensureDefaultAccount();
    if (!this.status) return;
    this.status.text = `$(account) ${acc.name}`;
    this.status.tooltip = new vscode.MarkdownString(
      `**Локальный аккаунт OllamaCode**\n\n` +
        `- Чатов: ${acc.chats.length}\n` +
        `- Воркспейсов: ${acc.workspaces.length}\n` +
        `- Репо: ${acc.repos.length}\n\n` +
        `Клик — переключить / создать аккаунт (всё локально, без облака).`
    );
  }

  private syncWorkspaceIntoActive(): void {
    const acc = getActiveAccount() || ensureDefaultAccount();
    for (const f of vscode.workspace.workspaceFolders || []) {
      touchWorkspace(acc, f.uri.fsPath, f.name);
      touchRepo(acc, f.uri.fsPath);
    }
    this.refreshStatus();
  }

  recordChat(title: string, preview?: string): void {
    const acc = getActiveAccount() || ensureDefaultAccount();
    upsertChat(acc, {
      id: `chat-${Date.now()}`,
      title: title.slice(0, 80),
      preview: preview?.slice(0, 200),
    });
    this.refreshStatus();
  }

  private async openMenu(): Promise<void> {
    const acc = getActiveAccount() || ensureDefaultAccount();
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: `$(account) Активный: ${acc.name}`,
          description: `${acc.chats.length} чатов · ${acc.workspaces.length} ws · ${acc.repos.length} repo`,
          id: "info",
        },
        { label: "$(arrow-swap) Переключить аккаунт", id: "switch" },
        { label: "$(add) Создать локальный аккаунт", id: "create" },
        { label: "$(edit) Переименовать", id: "rename" },
        { label: "$(trash) Удалить аккаунт", id: "delete" },
        { label: "$(database) Показать данные аккаунта", id: "data" },
        { label: "$(folder-opened) Открыть недавний воркспейс", id: "ws" },
      ],
      { title: "OllamaCode — локальные аккаунты (без облака)" }
    );
    if (!pick) return;
    if (pick.id === "switch") await this.switchFlow();
    else if (pick.id === "create") await this.createFlow();
    else if (pick.id === "rename") await this.renameFlow();
    else if (pick.id === "delete") await this.deleteFlow();
    else if (pick.id === "data") await this.showData();
    else if (pick.id === "ws") await this.openRecentWorkspace();
  }

  private async switchFlow(): Promise<void> {
    const active = getActiveAccount();
    const items = listAccounts().map((a) => ({
      label: a.id === active?.id ? `$(check) ${a.name}` : a.name,
      description: `${a.chats.length} чатов · ${a.workspaces.length} ws`,
      detail: a.id,
      id: a.id,
    }));
    items.push({
      label: "$(add) Новый аккаунт…",
      description: "",
      detail: "",
      id: "__new__",
    });
    const pick = await vscode.window.showQuickPick(items, {
      title: "Переключить локальный аккаунт",
    });
    if (!pick) return;
    if (pick.id === "__new__") {
      await this.createFlow();
      return;
    }
    const acc = switchAccount(pick.id);
    if (acc) {
      this.auth.notifyChanged(acc);
      this.refreshStatus();
      void vscode.window.showInformationMessage(`Аккаунт: ${acc.name}`);
    }
  }

  private async createFlow(): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: "Имя нового локального аккаунта",
      placeHolder: "work / home / freelance",
    });
    if (!name?.trim()) return;
    const acc = createAccount(name.trim());
    this.auth.notifyChanged(acc);
    this.syncWorkspaceIntoActive();
    this.refreshStatus();
    void vscode.window.showInformationMessage(`Создан аккаунт: ${acc.name}`);
  }

  private async renameFlow(): Promise<void> {
    const acc = getActiveAccount();
    if (!acc) return;
    const name = await vscode.window.showInputBox({
      prompt: "Новое имя",
      value: acc.name,
    });
    if (!name?.trim()) return;
    renameAccount(acc.id, name);
    this.auth.notifyChanged(loadAccount(acc.id));
    this.refreshStatus();
  }

  private async deleteFlow(): Promise<void> {
    const acc = getActiveAccount();
    if (!acc) return;
    const ok = await vscode.window.showWarningMessage(
      `Удалить локальный аккаунт «${acc.name}» и его метаданные чатов/воркспейсов?`,
      { modal: true },
      "Удалить"
    );
    if (ok !== "Удалить") return;
    try {
      await this.auth.removeSession(acc.id);
    } catch {
      deleteAccount(acc.id);
    }
    this.auth.notifyChanged();
    this.refreshStatus();
  }

  private async showData(): Promise<void> {
    const acc = getActiveAccount() || ensureDefaultAccount();
    const lines = [
      `# Локальный аккаунт: ${acc.name}`,
      "",
      `- id: \`${acc.id}\``,
      `- создан: ${acc.createdAt}`,
      `- чатов: ${acc.chats.length}`,
      `- воркспейсов: ${acc.workspaces.length}`,
      `- репо: ${acc.repos.length}`,
      "",
      "## Недавние чаты",
      ...acc.chats.slice(0, 15).map((c) => `- ${c.title} (${c.updatedAt})`),
      "",
      "## Воркспейсы",
      ...acc.workspaces.slice(0, 15).map((w) => `- ${w.name} — \`${w.path}\``),
      "",
      "## Репозитории",
      ...acc.repos.slice(0, 15).map((r) => `- \`${r.path}\`${r.branch ? ` @ ${r.branch}` : ""}`),
      "",
      `_Данные: %USERPROFILE%\\.ollamacode\\accounts\\${acc.id}_`,
    ];
    const doc = await vscode.workspace.openTextDocument({
      content: lines.join("\n"),
      language: "markdown",
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  private async openRecentWorkspace(): Promise<void> {
    const acc = getActiveAccount() || ensureDefaultAccount();
    if (!acc.workspaces.length) {
      void vscode.window.showInformationMessage("Нет сохранённых воркспейсов у этого аккаунта");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      acc.workspaces.map((w) => ({
        label: w.name,
        description: w.path,
        path: w.path,
      })),
      { title: "Недавние воркспейсы аккаунта" }
    );
    if (!pick) return;
    const where = await vscode.window.showQuickPick(
      [
        { label: "Это окно", newWin: false },
        { label: "Новое окно", newWin: true },
      ],
      { title: "Открыть воркспейс" }
    );
    if (!where) return;
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(pick.path),
      where.newWin
    );
  }
}

export const PROVIDER_ID_LOCAL = PROVIDER_ID;
