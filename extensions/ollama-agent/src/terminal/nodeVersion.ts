import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import * as vscode from "vscode";

export interface NodeVersionInfo {
  version: string; // e.g. 22.22.3
  dir: string;
  installed: boolean;
  lts?: boolean | string;
}

const terminalVersions = new WeakMap<vscode.Terminal, string>();

/** Green Node hexagon SVG — used for terminal tabs (status bar uses contributed ThemeIcon id). */
let nodeIconUri: vscode.Uri | undefined;

function nodeIconPath(): vscode.Uri | vscode.ThemeIcon {
  return nodeIconUri ?? new vscode.ThemeIcon("server-process");
}

function nvmHome(): string | undefined {
  const fromEnv = (process.env.NVM_HOME || "").trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const local = path.join(os.homedir(), "AppData", "Local", "nvm");
  if (fs.existsSync(local)) return local;
  if (fs.existsSync("C:\\nvm4w")) {
    // nvm4w sometimes only holds symlink; real root in settings
    const settings = path.join("C:\\nvm4w", "settings.txt");
    if (fs.existsSync(settings)) {
      const txt = fs.readFileSync(settings, "utf8");
      const m = txt.match(/root:\s*(.+)/i);
      if (m?.[1] && fs.existsSync(m[1].trim())) return m[1].trim();
    }
  }
  return undefined;
}

function nvmSymlink(): string {
  return (process.env.NVM_SYMLINK || "C:\\nvm4w\\nodejs").trim();
}

export function listInstalledNodeVersions(): NodeVersionInfo[] {
  const home = nvmHome();
  if (!home) return [];
  const out: NodeVersionInfo[] = [];
  for (const name of fs.readdirSync(home)) {
    const m = /^v(\d+\.\d+\.\d+)$/.exec(name);
    if (!m) continue;
    const dir = path.join(home, name);
    const exe = path.join(dir, process.platform === "win32" ? "node.exe" : "node");
    if (!fs.existsSync(exe)) continue;
    out.push({ version: m[1], dir, installed: true });
  }
  return out.sort((a, b) => compareSemver(b.version, a.version));
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** PATH with chosen Node first; strips nvm symlink + other nvm version dirs so terminals stay independent. */
export function envForNodeVersion(version: string): Record<string, string> {
  const home = nvmHome();
  if (!home) throw new Error("nvm-windows not found (NVM_HOME)");
  const dir = path.join(home, `v${version}`);
  if (!fs.existsSync(path.join(dir, "node.exe")) && !fs.existsSync(path.join(dir, "node"))) {
    throw new Error(`Node ${version} not installed at ${dir}`);
  }
  const symlink = nvmSymlink().toLowerCase();
  const parts = (process.env.PATH || process.env.Path || "")
    .split(path.delimiter)
    .filter((p) => {
      if (!p) return false;
      const lower = p.toLowerCase();
      if (lower === symlink) return false;
      if (lower.includes("\\nvm4w\\nodejs")) return false;
      if (/\\nvm\\v\d+\.\d+\.\d+/i.test(lower)) return false;
      return true;
    });
  return {
    PATH: [dir, ...parts].join(path.delimiter),
    Path: [dir, ...parts].join(path.delimiter),
    OLLAMACODE_NODE_VERSION: version,
  };
}

export async function fetchRemoteNodeVersions(): Promise<NodeVersionInfo[]> {
  const res = await fetch("https://nodejs.org/dist/index.json");
  if (!res.ok) throw new Error(`nodejs.org ${res.status}`);
  const data = (await res.json()) as Array<{ version: string; lts: boolean | string }>;
  const installed = new Set(listInstalledNodeVersions().map((v) => v.version));
  const out: NodeVersionInfo[] = [];
  for (const row of data.slice(0, 80)) {
    const version = String(row.version || "").replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    out.push({
      version,
      dir: "",
      installed: installed.has(version),
      lts: row.lts,
    });
  }
  return out;
}

function shellKind(term?: vscode.Terminal): "powershell" | "cmd" | "bash" {
  const name = (term?.name || "").toLowerCase();
  if (name.includes("bash") || name.includes("git")) return "bash";
  if (name.includes("cmd")) return "cmd";
  // default on Windows
  return process.platform === "win32" ? "powershell" : "bash";
}

/** Inject PATH into an already-running shell without touching global nvm symlink. */
export function applyNodeToExistingTerminal(term: vscode.Terminal, version: string): void {
  const env = envForNodeVersion(version);
  const nodeDir = env.PATH.split(path.delimiter)[0];
  const kind = shellKind(term);
  let script: string;
  if (kind === "powershell") {
    script = [
      `$__ocNode='${nodeDir.replace(/'/g, "''")}'`,
      `$env:Path = ($__ocNode + ';' + (($env:Path -split ';' | Where-Object { $_ -and $_ -notmatch 'nvm4w\\\\nodejs|\\\\nvm\\\\v\\d' }) -join ';'))`,
      `$env:OLLAMACODE_NODE_VERSION='${version}'`,
      `Write-Host ("OllamaCode: Node " + (node -v) + " @ $__ocNode") -ForegroundColor Cyan`,
    ].join("; ");
  } else if (kind === "cmd") {
    script = `set "PATH=${nodeDir};%PATH%" && set OLLAMACODE_NODE_VERSION=${version} && echo OllamaCode: && node -v`;
  } else {
    script = `export PATH="${nodeDir}:$(echo "$PATH" | tr ':' '\\n' | grep -v -E 'nvm4w/nodejs|/nvm/v[0-9]' | tr '\\n' ':')" && export OLLAMACODE_NODE_VERSION=${version} && echo "OllamaCode: $(node -v)"`;
  }
  term.show(true);
  term.sendText(script, true);
  terminalVersions.set(term, version);
}

export function createTerminalWithNode(version: string, name?: string): vscode.Terminal {
  const env = envForNodeVersion(version);
  const term = vscode.window.createTerminal({
    name: name || `Node ${version}`,
    env,
    iconPath: nodeIconPath(),
  });
  terminalVersions.set(term, version);
  term.show(true);
  // Confirm version in shell
  const kind = shellKind(term);
  if (kind === "powershell") {
    term.sendText(`Write-Host ("node " + (node -v)) -ForegroundColor Cyan`, true);
  } else {
    term.sendText(`node -v`, true);
  }
  return term;
}

export function getTerminalNodeVersion(term: vscode.Terminal | undefined): string | undefined {
  if (!term) return undefined;
  return terminalVersions.get(term);
}

async function nvmInstall(version: string): Promise<void> {
  const home = nvmHome();
  if (!home) throw new Error("nvm-windows not found");
  const nvmExe = path.join(home, "nvm.exe");
  if (!fs.existsSync(nvmExe)) throw new Error(`nvm.exe missing at ${nvmExe}`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `nvm install ${version}`,
      cancellable: false,
    },
    async () => {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(nvmExe, ["install", version], {
          shell: true,
          windowsHide: true,
          env: process.env,
        });
        let err = "";
        child.stderr.on("data", (d) => (err += d.toString()));
        child.stdout.on("data", () => {
          /* nvm prints progress */
        });
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(err || `nvm install exit ${code}`))
        );
      });
    }
  );
}

export function registerNodeVersionTerminal(context: vscode.ExtensionContext): void {
  nodeIconUri = vscode.Uri.joinPath(context.extensionUri, "media", "node.svg");

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "ollamaCode.terminalNodeVersion";
  status.tooltip = "Node version for this terminal (independent per tab)";
  context.subscriptions.push(status);

  const refreshStatus = () => {
    const term = vscode.window.activeTerminal;
    const pinned = getTerminalNodeVersion(term);
    if (term) {
      // Node hexagon U+2B22 (codicons have no Node logo; jersey was a t-shirt)
      status.text = pinned ? `\u2B22 Node ${pinned}` : `\u2B22 Node`;
      status.show();
    } else {
      status.hide();
    }
  };
  refreshStatus();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal(() => refreshStatus()),
    vscode.window.onDidOpenTerminal(() => refreshStatus()),
    vscode.window.onDidCloseTerminal(() => refreshStatus())
  );

  const pickAndApply = async () => {
    const installed = listInstalledNodeVersions();
    if (!nvmHome()) {
      const open = await vscode.window.showErrorMessage(
        "nvm-windows не найден. Установи nvm-windows, затем повтори.",
        "Открыть nvm-windows"
      );
      if (open) {
        await vscode.env.openExternal(
          vscode.Uri.parse("https://github.com/coreybutler/nvm-windows/releases")
        );
      }
      return;
    }

    type Item = vscode.QuickPickItem & {
      id: "ver" | "download" | "refresh";
      version?: string;
    };

    const items: Item[] = [
      ...installed.map(
        (v): Item => ({
          id: "ver",
          version: v.version,
          label: `$(check) Node ${v.version}`,
          description: "установлена",
          detail: v.dir,
        })
      ),
      {
        id: "download",
        label: "$(cloud-download) Скачать другую версию с nodejs.org…",
        description: "nvm install",
      },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: "Node для терминала (каждая вкладка независимо)",
      placeHolder: "Один терминал — 22, другой — 16",
    });
    if (!picked) return;

    if (picked.id === "download") {
      await downloadFlow();
      return;
    }
    if (!picked.version) return;

    const how = await vscode.window.showQuickPick(
      [
        {
          id: "new",
          label: "$(add) Новый терминал с этой Node",
          description: `Node ${picked.version}`,
        },
        {
          id: "active",
          label: "$(terminal) Применить к активному терминалу",
          description: "только PATH этой вкладки, без nvm use",
        },
      ],
      { title: `Node ${picked.version}` }
    );
    if (!how) return;

    if (how.id === "new") {
      createTerminalWithNode(picked.version);
    } else {
      const term = vscode.window.activeTerminal;
      if (!term) {
        createTerminalWithNode(picked.version);
      } else {
        applyNodeToExistingTerminal(term, picked.version);
      }
    }
    refreshStatus();
  };

  const downloadFlow = async () => {
    let remote: NodeVersionInfo[] = [];
    try {
      remote = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Загрузка списка с nodejs.org…",
        },
        () => fetchRemoteNodeVersions()
      );
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Не удалось получить список: ${e?.message || e}`);
      return;
    }

    const items = remote.map((v) => ({
      label: `${v.installed ? "$(check) " : "$(cloud-download) "}Node ${v.version}`,
      description: v.installed
        ? "уже установлена"
        : v.lts
          ? `LTS${typeof v.lts === "string" ? ` (${v.lts})` : ""}`
          : "Current",
      version: v.version,
      installed: v.installed,
    }));

    const pick = await vscode.window.showQuickPick(items, {
      title: "Скачать Node (nvm install)",
      matchOnDescription: true,
    });
    if (!pick) return;

    if (pick.installed) {
      const use = await vscode.window.showInformationMessage(
        `Node ${pick.version} уже есть. Открыть терминал?`,
        "Новый терминал",
        "В активный"
      );
      if (use === "Новый терминал") createTerminalWithNode(pick.version);
      else if (use === "В активный" && vscode.window.activeTerminal) {
        applyNodeToExistingTerminal(vscode.window.activeTerminal, pick.version);
      }
      refreshStatus();
      return;
    }

    try {
      await nvmInstall(pick.version);
      void vscode.window.showInformationMessage(`Node ${pick.version} установлена`);
      const open = await vscode.window.showInformationMessage(
        `Открыть терминал на Node ${pick.version}?`,
        "Да",
        "Нет"
      );
      if (open === "Да") createTerminalWithNode(pick.version);
      refreshStatus();
    } catch (e: any) {
      void vscode.window.showErrorMessage(`nvm install: ${e?.message || e}`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("ollamaCode.terminalNodeVersion", () => pickAndApply()),
    vscode.commands.registerCommand("ollamaCode.terminalNodeNew", async () => {
      const installed = listInstalledNodeVersions();
      const pick = await vscode.window.showQuickPick(
        installed.map((v) => ({ label: `Node ${v.version}`, version: v.version })),
        { title: "Новый терминал с Node" }
      );
      if (pick) createTerminalWithNode(pick.version);
      refreshStatus();
    })
  );

  // Appears in terminal "+" profile list
  try {
    context.subscriptions.push(
      vscode.window.registerTerminalProfileProvider("ollamacode.node.picker", {
        provideTerminalProfile: async () => {
          const installed = listInstalledNodeVersions();
          const pick = await vscode.window.showQuickPick(
            installed.map((v) => ({
              label: `Node ${v.version}`,
              version: v.version,
            })),
            { title: "Профиль терминала: Node" }
          );
          if (!pick) {
            return undefined as any;
          }
          return {
            options: {
              name: `Node ${pick.version}`,
              env: envForNodeVersion(pick.version),
              iconPath: nodeIconPath(),
            },
          };
        },
      })
    );
  } catch {
    /* ignore */
  }
}
