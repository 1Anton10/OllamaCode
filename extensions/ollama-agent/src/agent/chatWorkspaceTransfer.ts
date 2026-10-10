/**
 * Migrate native chatSessions between workspaceStorage folders when the agent
 * moves the chat to another project. Cursor/LocalC stub transferActiveChat, and
 * LIVE_FOLDER id changes leave the new workspace with 0 chats after reload.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

let workspaceStorageRoot: string | undefined;

/** Call once from extension activate (context.storageUri → …/workspaceStorage/<id>). */
export function initChatWorkspaceTransfer(storageUri: vscode.Uri | undefined): void {
  if (!storageUri) return;
  const idDir = storageUri.fsPath;
  const root = path.dirname(idDir);
  if (/workspaceStorage$/i.test(root)) {
    workspaceStorageRoot = root;
  }
}

export function getWorkspaceStorageRoot(): string | undefined {
  if (workspaceStorageRoot && fs.existsSync(workspaceStorageRoot)) {
    return workspaceStorageRoot;
  }
  // Fallback: walk up from log path / known launch userdata
  const candidates: string[] = [];
  try {
    const log = (vscode.env as { logFile?: vscode.Uri }).logFile?.fsPath;
    if (log) {
      // …/logs/<date>/… → User/ → workspaceStorage
      let p = path.dirname(log);
      for (let i = 0; i < 6; i++) {
        const ws = path.join(p, "User", "workspaceStorage");
        if (fs.existsSync(ws)) {
          candidates.push(ws);
          break;
        }
        const ws2 = path.join(p, "workspaceStorage");
        if (fs.existsSync(ws2)) {
          candidates.push(ws2);
          break;
        }
        p = path.dirname(p);
      }
    }
  } catch {
    /* ignore */
  }
  for (const c of [
    path.join(process.cwd(), ".userdata-oss", "User", "workspaceStorage"),
    path.join(__dirname, "..", "..", "..", "..", ".userdata-oss", "User", "workspaceStorage"),
  ]) {
    if (fs.existsSync(c)) candidates.push(path.normalize(c));
  }
  workspaceStorageRoot = candidates.find((c) => fs.existsSync(c));
  return workspaceStorageRoot;
}

function folderUriKey(folderPath: string): string {
  return vscode.Uri.file(path.normalize(folderPath)).toString().toLowerCase();
}

function readWorkspaceMeta(dir: string): { folder?: string; workspace?: string } | undefined {
  const f = path.join(dir, "workspace.json");
  if (!fs.existsSync(f)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
}

function findStorageDirForFolder(root: string, folderPath: string): string | undefined {
  const want = folderUriKey(folderPath);
  const wantFs = path.normalize(folderPath).toLowerCase();
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const meta = readWorkspaceMeta(dir);
    if (!meta?.folder) continue;
    try {
      const u = vscode.Uri.parse(meta.folder);
      if (u.fsPath && path.normalize(u.fsPath).toLowerCase() === wantFs) return dir;
      if (meta.folder.toLowerCase() === want) return dir;
    } catch {
      if (meta.folder.toLowerCase() === want) return dir;
    }
  }
  return undefined;
}

/** Same salt as VS Code getSingleFolderWorkspaceIdentifier (file + ctime). */
function computeFolderWorkspaceId(folderPath: string): string | undefined {
  try {
    const st = fs.statSync(folderPath);
    const uri = vscode.Uri.file(path.normalize(folderPath));
    const ctime =
      typeof st.birthtimeMs === "number" ? Math.floor(st.birthtimeMs) : st.birthtime.getTime();
    return crypto.createHash("md5").update(uri.fsPath).update(String(ctime)).digest("hex");
  } catch {
    return undefined;
  }
}

/** All id schemes hosts may use (md5 fsPath+ctime, md5 uri, LIVE_FOLDER hash). */
function candidateWorkspaceIds(folderPath: string): string[] {
  const ids: string[] = [];
  const uri = vscode.Uri.file(path.normalize(folderPath));
  const withCtime = computeFolderWorkspaceId(folderPath);
  if (withCtime) ids.push(withCtime);
  ids.push(crypto.createHash("md5").update(uri.toString()).digest("hex"));
  // stringHash → signed 32-bit hex (VS Code browser / LIVE_FOLDER_PERSIST)
  let h = 0;
  const s = uri.toString();
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  ids.push((h >>> 0).toString(16));
  ids.push((h | 0).toString(16));
  return [...new Set(ids)];
}

function ensureStorageDir(root: string, folderPath: string, id: string): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const metaPath = path.join(dir, "workspace.json");
  if (!fs.existsSync(metaPath)) {
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ folder: vscode.Uri.file(path.normalize(folderPath)).toString() }, null, 2),
      "utf8"
    );
  }
  return dir;
}

function copyDirFiles(src: string, dst: string): number {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    if (!fs.statSync(from).isFile()) continue;
    if (fs.existsSync(to)) continue; // don't clobber newer/existing
    fs.copyFileSync(from, to);
    n++;
  }
  return n;
}

export type ChatMigrateResult = {
  ok: boolean;
  copied: number;
  detail: string;
  fromId?: string;
  toId?: string;
};

/**
 * Copy chatSessions (+ editing sessions) from current folder's storage to target.
 * Safe to call on soft move and before hard openFolder.
 */
export function migrateChatSessionsToFolder(targetFolder: string): ChatMigrateResult {
  const root = getWorkspaceStorageRoot();
  if (!root) {
    return { ok: false, copied: 0, detail: "workspaceStorage root not found" };
  }
  const fromFolder =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
    /* agent override already pointed elsewhere */ "";
  const toNorm = path.normalize(targetFolder);
  if (!fromFolder) {
    return { ok: false, copied: 0, detail: "no current workspace folder" };
  }
  if (path.normalize(fromFolder).toLowerCase() === toNorm.toLowerCase()) {
    return { ok: true, copied: 0, detail: "same folder — nothing to migrate" };
  }

  const srcDir = findStorageDirForFolder(root, fromFolder);
  if (!srcDir) {
    return {
      ok: false,
      copied: 0,
      detail: `source storage not found for ${fromFolder}`,
    };
  }

  const destIds = candidateWorkspaceIds(toNorm);
  let copied = 0;
  const destNames: string[] = [];
  for (const id of destIds) {
    const dst = ensureStorageDir(root, toNorm, id);
    if (dst === srcDir) continue;
    const n1 = copyDirFiles(path.join(srcDir, "chatSessions"), path.join(dst, "chatSessions"));
    const n2 = copyDirFiles(
      path.join(srcDir, "chatEditingSessions"),
      path.join(dst, "chatEditingSessions")
    );
    if (n1 + n2 > 0) {
      copied += n1 + n2;
      destNames.push(id.slice(0, 12));
    } else if (!destNames.length) {
      destNames.push(id.slice(0, 12));
    }
  }
  // Also refresh existing storage dirs already mapped to target folder
  const existingDst = findStorageDirForFolder(root, toNorm);
  if (existingDst && existingDst !== srcDir) {
    copied += copyDirFiles(
      path.join(srcDir, "chatSessions"),
      path.join(existingDst, "chatSessions")
    );
    copied += copyDirFiles(
      path.join(srcDir, "chatEditingSessions"),
      path.join(existingDst, "chatEditingSessions")
    );
  }

  return {
    ok: true,
    copied,
    detail:
      copied > 0
        ? `migrated ${copied} file(s) → ${destNames.join(",") || "target storage"}`
        : `target storage ready (${destNames.join(",") || "ids"}); nothing new to copy`,
    fromId: path.basename(srcDir),
    toId: destNames[0],
  };
}
