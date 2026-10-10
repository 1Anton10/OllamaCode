/**
 * Fix OLLAMACODE_LIVE_FOLDER so folder label + window-restore follow the new path.
 * - renderer: new workspace id + enterFolderWorkspace + recents
 * - main: window.config.workspace = new single-folder identifier
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const oss = path.join(root, ".cache/vscode-140");
const MARKER = "OLLAMACODE_LIVE_FOLDER_PERSIST";

function writeIfChanged(file, next) {
  const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (prev === next) return false;
  fs.writeFileSync(file, next);
  return true;
}

// ---------- SOURCE ----------
{
  const p = path.join(
    oss,
    "src/vs/platform/workspaces/common/workspaces.ts"
  );
  let s = fs.readFileSync(p, "utf8");
  if (!s.includes("enterFolderWorkspace")) {
    s = s.replace(
      "enterWorkspace(workspaceUri: URI): Promise<IEnterWorkspaceResult | undefined>;",
      "enterWorkspace(workspaceUri: URI): Promise<IEnterWorkspaceResult | undefined>;\n\t/** OLLAMACODE: sync native window folder without reload */\n\tenterFolderWorkspace(folderUri: URI): Promise<void>;"
    );
    fs.writeFileSync(p, s);
    console.log("✓ IWorkspacesService.enterFolderWorkspace");
  }
}

{
  const p = path.join(
    oss,
    "src/vs/platform/workspaces/electron-main/workspacesManagementMainService.ts"
  );
  let s = fs.readFileSync(p, "utf8");
  if (!s.includes("enterFolderWorkspace")) {
    if (!s.includes("getSingleFolderWorkspaceIdentifier")) {
      s = s.replace(
        "import { getStoredWorkspaceFolder, IEnterWorkspaceResult, isStoredWorkspaceFolder, IStoredWorkspace, IStoredWorkspaceFolder, IUntitledWorkspaceInfo, IWorkspaceFolderCreationData, toWorkspaceFolders } from '../common/workspaces.js';",
        "import { getStoredWorkspaceFolder, IEnterWorkspaceResult, isStoredWorkspaceFolder, IStoredWorkspace, IStoredWorkspaceFolder, IUntitledWorkspaceInfo, IWorkspaceFolderCreationData, toWorkspaceFolders } from '../common/workspaces.js';\nimport { getSingleFolderWorkspaceIdentifier } from '../node/workspaces.js';\nimport { promises as fsPromises } from 'fs';"
      );
    }
    s = s.replace(
      "enterWorkspace(intoWindow: ICodeWindow, openedWindows: ICodeWindow[], path: URI): Promise<IEnterWorkspaceResult | undefined>;",
      "enterWorkspace(intoWindow: ICodeWindow, openedWindows: ICodeWindow[], path: URI): Promise<IEnterWorkspaceResult | undefined>;\n\tenterFolderWorkspace(intoWindow: ICodeWindow, folderUri: URI): Promise<void>;"
    );
    // append method before last closing of class - before final `}`
    const method = `
	async enterFolderWorkspace(window: ICodeWindow, folderUri: URI): Promise<void> {
		if (!window?.win || !window.isReady || !window.config) {
			return;
		}
		let workspace = folderUri.scheme === Schemas.file
			? getSingleFolderWorkspaceIdentifier(folderUri, await fsPromises.stat(folderUri.fsPath))
			: getSingleFolderWorkspaceIdentifier(folderUri);
		if (!workspace) {
			workspace = getSingleFolderWorkspaceIdentifier(folderUri, await fsPromises.stat(folderUri.fsPath));
		}
		if (!workspace) {
			return;
		}
		let backupPath: string | undefined;
		if (!window.config.extensionDevelopmentPath) {
			backupPath = this.backupMainService.registerFolderBackup({ folderUri, remoteAuthority: window.remoteAuthority });
		}
		window.config.workspace = workspace;
		if (backupPath) {
			window.config.backupPath = backupPath;
		}
	}
`;
    // insert before last method's closing - after doEnterWorkspace's closing brace of class
    const anchor = "\tprivate async doEnterWorkspace(window: ICodeWindow, workspace: IWorkspaceIdentifier): Promise<IEnterWorkspaceResult | undefined> {";
    if (!s.includes(anchor)) {
      console.warn("⚠ management anchor missing");
    } else {
      s = s.replace(anchor, method + "\n" + anchor);
    }
    // Schemas import?
    if (!s.includes("Schemas")) {
      s = s.replace(
        "import { URI } from '../../../base/common/uri.js';",
        "import { URI } from '../../../base/common/uri.js';\nimport { Schemas } from '../../../base/common/network.js';"
      );
    }
    fs.writeFileSync(p, s);
    console.log("✓ WorkspacesManagementMainService.enterFolderWorkspace");
  }
}

{
  const p = path.join(
    oss,
    "src/vs/platform/workspaces/electron-main/workspacesMainService.ts"
  );
  let s = fs.readFileSync(p, "utf8");
  if (!s.includes("enterFolderWorkspace")) {
    s = s.replace(
      `async enterWorkspace(windowId: number, path: URI): Promise<IEnterWorkspaceResult | undefined> {
		const window = this.windowsMainService.getWindowById(windowId);
		if (window) {
			return this.workspacesManagementMainService.enterWorkspace(window, this.windowsMainService.getWindows(), path);
		}

		return undefined;
	}`,
      `async enterWorkspace(windowId: number, path: URI): Promise<IEnterWorkspaceResult | undefined> {
		const window = this.windowsMainService.getWindowById(windowId);
		if (window) {
			return this.workspacesManagementMainService.enterWorkspace(window, this.windowsMainService.getWindows(), path);
		}

		return undefined;
	}

	async enterFolderWorkspace(windowId: number, folderUri: URI): Promise<void> {
		const window = this.windowsMainService.getWindowById(windowId);
		if (window) {
			await this.workspacesManagementMainService.enterFolderWorkspace(window, folderUri);
		}
	}`
    );
    fs.writeFileSync(p, s);
    console.log("✓ WorkspacesMainService.enterFolderWorkspace");
  }
}

{
  const p = path.join(
    oss,
    "src/vs/workbench/services/workspaces/browser/workspacesService.ts"
  );
  let s = fs.readFileSync(p, "utf8");
  if (!s.includes("enterFolderWorkspace")) {
    s = s.replace(
      `enterWorkspace(workspaceUri: URI): Promise<IEnterWorkspaceResult | undefined> {
		return { workspace: await this.getWorkspaceIdentifier(workspaceUri) };
	}`,
      `enterWorkspace(workspaceUri: URI): Promise<IEnterWorkspaceResult | undefined> {
		return { workspace: await this.getWorkspaceIdentifier(workspaceUri) };
	}

	async enterFolderWorkspace(_folderUri: URI): Promise<void> {
		// browser: no native window config to sync
	}`
    );
    fs.writeFileSync(p, s);
    console.log("✓ browser WorkspacesService stub");
  }
}

{
  const p = path.join(
    oss,
    "src/vs/workbench/services/workspaces/browser/abstractWorkspaceEditingService.ts"
  );
  let s = fs.readFileSync(p, "utf8");
  if (!s.includes(MARKER)) {
    if (!s.includes("getSingleFolderWorkspaceIdentifier")) {
      s = s.replace(
        "import { WorkspaceService } from '../../configuration/browser/configurationService.js';",
        "import { WorkspaceService } from '../../configuration/browser/configurationService.js';\nimport { getSingleFolderWorkspaceIdentifier } from '../../../../platform/workspaces/common/workspaceIdentifier.js';"
      );
    }
    const oldMethodStart = s.indexOf("liveReplaceSingleFolderWorkspace");
    if (oldMethodStart < 0) {
      console.warn("⚠ liveReplace method missing — run live-folder patch first");
    } else {
      // replace whole method body via regex
      const re =
        /private async liveReplaceSingleFolderWorkspace\(folder: IWorkspaceFolderCreationData\): Promise<void> \{[\s\S]*?\n\t\}\n/;
      const neu = `private async liveReplaceSingleFolderWorkspace(folder: IWorkspaceFolderCreationData): Promise<void> {
\t\tconst uri = removeTrailingPathSeparator(folder.uri);
\t\tconst oldWorkspace = toWorkspaceIdentifier(this.contextService.getWorkspace());
\t\t// ${MARKER}: stable id for new path (matches cold-open workspaceStorage)
\t\tconst identifier = getSingleFolderWorkspaceIdentifier(uri);
\t\tthis.logService.info(\`[OLLAMACODE_LIVE_FOLDER] \${uri.toString()} id=\${identifier.id}\`);
\t\tawait this.contextService.initialize(identifier);
\t\ttry {
\t\t\tawait this.workspacesService.enterFolderWorkspace(uri);
\t\t} catch (e) {
\t\t\tthis.logService.warn('[OLLAMACODE_LIVE_FOLDER] native folder sync failed', e);
\t\t}
\t\ttry {
\t\t\tawait this.workspacesService.addRecentlyOpened([{ folderUri: uri }]);
\t\t} catch {
\t\t\t/* ignore */
\t\t}
\t\tawait this.fireDidEnterWorkspace(oldWorkspace, identifier);
\t}
`;
      if (!re.test(s)) {
        console.warn("⚠ could not replace liveReplace method");
      } else {
        s = s.replace(re, neu + "\n");
        fs.writeFileSync(p, s);
        console.log("✓ liveReplace persist (source)");
      }
    }
  } else {
    console.log("· source liveReplace already persist");
  }
}

// ---------- BUNDLE: workbench ----------
{
  const p = path.join(oss, "out-fast/vs/workbench/workbench.desktop.main.js");
  let s = fs.readFileSync(p, "utf8");
  const old = `async liveReplaceSingleFolderWorkspace(folder) {
    // OLLAMACODE_LIVE_FOLDER: keep EH + chat alive; swap the only root in-place
    const uri = folder.uri;
    const oldWorkspace = toWorkspaceIdentifier(this.contextService.getWorkspace());
    const identifier = { id: this.contextService.getWorkspace().id, uri };
    this.logService.info(\`[OLLAMACODE_LIVE_FOLDER] \${uri.toString()}\`);
    await this.contextService.initialize(identifier);
    await this.fireDidEnterWorkspace(oldWorkspace, identifier);
  }`;
  const neu = `async liveReplaceSingleFolderWorkspace(folder) {
    // OLLAMACODE_LIVE_FOLDER + ${MARKER}
    const uri = folder.uri;
    const oldWorkspace = toWorkspaceIdentifier(this.contextService.getWorkspace());
    // Prefer stable single-folder id when available (matches cold open / workspaceStorage)
    let identifier = typeof getSingleFolderWorkspaceIdentifier === "function"
      ? getSingleFolderWorkspaceIdentifier(uri)
      : { id: hash(uri.toString()).toString(16), uri };
    if (!identifier?.id) {
      identifier = { id: hash(uri.toString()).toString(16), uri };
    }
    this.logService.info(\`[OLLAMACODE_LIVE_FOLDER] \${uri.toString()} id=\${identifier.id}\`);
    await this.contextService.initialize(identifier);
    try {
      await this.workspacesService.enterFolderWorkspace(uri);
    } catch (e) {
      this.logService.warn("[OLLAMACODE_LIVE_FOLDER] native folder sync failed", e);
    }
    try {
      await this.workspacesService.addRecentlyOpened([{ folderUri: uri }]);
    } catch {
    }
    await this.fireDidEnterWorkspace(oldWorkspace, identifier);
  }`;
  if (s.includes(MARKER)) {
    console.log("· workbench already persist");
  } else if (!s.includes(old)) {
    // try looser match
    const i = s.indexOf("async liveReplaceSingleFolderWorkspace(folder)");
    if (i < 0) console.warn("⚠ workbench liveReplace missing");
    else {
      const end = s.indexOf("includesSingleFolderWorkspace(folders)", i);
      if (end < 0) console.warn("⚠ workbench end anchor missing");
      else {
        s = s.slice(0, i) + neu + "\n\n  " + s.slice(end);
        fs.writeFileSync(p, s);
        console.log("✓ workbench liveReplace persist (loose)");
      }
    }
  } else {
    s = s.replace(old, neu);
    fs.writeFileSync(p, s);
    console.log("✓ workbench liveReplace persist");
  }
}

// ---------- BUNDLE: mainImpl ----------
for (const rel of ["out-fast/mainImpl.js", "out/mainImpl.js"]) {
  const p = path.join(oss, rel);
  if (!fs.existsSync(p)) continue;
  let s = fs.readFileSync(p, "utf8");
  if (s.includes(MARKER)) {
    console.log(`· ${rel} already persist`);
    continue;
  }
  // MainService method
  const mainOld = `async enterWorkspace(windowId, path3) {
        const window = this.windowsMainService.getWindowById(windowId);
        if (window) {
          return this.workspacesManagementMainService.enterWorkspace(window, this.windowsMainService.getWindows(), path3);
        }
        return void 0;
      }
      createUntitledWorkspace(windowId, folders, remoteAuthority) {`;
  const mainNew = `async enterWorkspace(windowId, path3) {
        const window = this.windowsMainService.getWindowById(windowId);
        if (window) {
          return this.workspacesManagementMainService.enterWorkspace(window, this.windowsMainService.getWindows(), path3);
        }
        return void 0;
      }
      async enterFolderWorkspace(windowId, folderUri) {
        // ${MARKER}
        const window = this.windowsMainService.getWindowById(windowId);
        if (window) {
          await this.workspacesManagementMainService.enterFolderWorkspace(window, folderUri);
        }
      }
      createUntitledWorkspace(windowId, folders, remoteAuthority) {`;
  if (!s.includes(mainOld)) {
    console.warn(`⚠ ${rel} MainService pattern missing`);
  } else {
    s = s.replace(mainOld, mainNew);
  }

  // Management method — insert before doEnterWorkspace
  const mgmtAnchor = "async doEnterWorkspace(window, workspace) {";
  const mgmtMethod = `async enterFolderWorkspace(window, folderUri) {
        // ${MARKER}
        if (!window?.win || !window.isReady || !window.config) {
          return;
        }
        let workspace;
        try {
          if (folderUri.scheme === "file") {
            const st = await import("fs").then((m) => m.promises.stat(folderUri.fsPath));
            workspace = getSingleFolderWorkspaceIdentifier(folderUri, st);
          } else {
            workspace = getSingleFolderWorkspaceIdentifier(folderUri);
          }
        } catch {
          workspace = void 0;
        }
        if (!workspace) {
          workspace = { id: createHash("md5").update(folderUri.toString()).digest("hex"), uri: folderUri };
        }
        let backupPath;
        if (!window.config.extensionDevelopmentPath) {
          backupPath = this.backupMainService.registerFolderBackup({ folderUri, remoteAuthority: window.remoteAuthority });
        }
        window.config.workspace = workspace;
        if (backupPath) {
          window.config.backupPath = backupPath;
        }
      }
      `;
  if (!s.includes(mgmtAnchor)) {
    console.warn(`⚠ ${rel} doEnterWorkspace missing`);
  } else if (!s.includes("async enterFolderWorkspace(window, folderUri)")) {
    s = s.replace(mgmtAnchor, mgmtMethod + mgmtAnchor);
  }

  // createHash might be createHash3 in bundle - check
  if (s.includes(MARKER) && s.includes('createHash("md5")') && !s.includes("function createHash(") && s.includes("createHash3")) {
    s = s.replace('createHash("md5")', 'createHash3("md5")');
  }

  fs.writeFileSync(p, s);
  console.log(`✓ ${rel} enterFolderWorkspace`);
}

console.log("Done. Restart LocalCursor (full quit) to load mainImpl + workbench patches.");
