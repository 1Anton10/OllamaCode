import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const IGNORE = new Set([
  "node_modules",
  ".git",
  "out",
  "dist",
  ".cache",
  ".userdata-oss",
  "build",
  ".next",
  "coverage",
]);

export interface RepoEntry {
  rel: string;
  size: number;
  mtime: number;
  ext: string;
  symbols: string[];
}

let cache: { root: string; entries: RepoEntry[]; at: number } | undefined;
let watcher: vscode.FileSystemWatcher | undefined;
let debounce: NodeJS.Timeout | undefined;

function workspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
}

function indexDir(): string {
  return path.join(workspaceRoot(), ".ollamacode", "index");
}

function extractSymbols(content: string, ext: string): string[] {
  const syms: string[] = [];
  const patterns: RegExp[] = [];
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(ext)) {
    patterns.push(
      /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/g,
      /(?:export\s+)?class\s+([A-Za-z0-9_]+)/g,
      /(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=/g
    );
  } else if (/\.(py)$/i.test(ext)) {
    patterns.push(/^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)/gm, /^\s*class\s+([A-Za-z0-9_]+)/gm);
  } else if (/\.(go)$/i.test(ext)) {
    patterns.push(/func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)/g, /type\s+([A-Za-z0-9_]+)/g);
  } else if (/\.(rs)$/i.test(ext)) {
    patterns.push(/(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g, /(?:pub\s+)?struct\s+([A-Za-z0-9_]+)/g);
  }
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) && syms.length < 40) {
      if (m[1] && !syms.includes(m[1])) syms.push(m[1]);
    }
  }
  return syms;
}

function walk(dir: string, root: string, out: RepoEntry[], depth: number): void {
  if (depth > 8 || out.length > 4000) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (IGNORE.has(e.name) || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, root, out, depth + 1);
      continue;
    }
    try {
      const st = fs.statSync(full);
      if (st.size > 512_000) {
        out.push({
          rel: path.relative(root, full).replace(/\\/g, "/"),
          size: st.size,
          mtime: st.mtimeMs,
          ext: path.extname(e.name),
          symbols: [],
        });
        continue;
      }
      const ext = path.extname(e.name);
      let symbols: string[] = [];
      if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs)$/i.test(ext)) {
        const content = fs.readFileSync(full, "utf8").slice(0, 80_000);
        symbols = extractSymbols(content, ext);
      }
      out.push({
        rel: path.relative(root, full).replace(/\\/g, "/"),
        size: st.size,
        mtime: st.mtimeMs,
        ext,
        symbols,
      });
    } catch {
      /* skip */
    }
  }
}

function persist(entries: RepoEntry[]): void {
  try {
    const dir = indexDir();
    fs.mkdirSync(dir, { recursive: true });
    const lines = entries.map((e) => JSON.stringify(e)).join("\n");
    fs.writeFileSync(path.join(dir, "repo_map.jsonl"), lines, "utf8");
  } catch {
    /* ignore */
  }
}

export function buildRepoMap(force = false): RepoEntry[] {
  const root = workspaceRoot();
  if (!force && cache && cache.root === root && Date.now() - cache.at < 60_000) {
    return cache.entries;
  }
  const entries: RepoEntry[] = [];
  walk(root, root, entries, 0);
  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  cache = { root, entries, at: Date.now() };
  persist(entries);
  return entries;
}

export async function getRepoMapSummary(maxChars = 2000): Promise<string> {
  const entries = buildRepoMap();
  const lines: string[] = [`files=${entries.length}`];
  for (const e of entries) {
    const sym = e.symbols.length ? ` {${e.symbols.slice(0, 8).join(",")}}` : "";
    const line = `${e.rel}${sym}`;
    if (lines.join("\n").length + line.length > maxChars) break;
    lines.push(line);
  }
  return lines.join("\n");
}

export function ensureRepoMapWatcher(disposables: vscode.Disposable[]): void {
  if (watcher) return;
  const root = workspaceRoot();
  watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(root, "**/*")
  );
  const bump = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      cache = undefined;
      try {
        buildRepoMap(true);
      } catch {
        /* ignore */
      }
    }, 300);
  };
  watcher.onDidCreate(bump);
  watcher.onDidChange(bump);
  watcher.onDidDelete(bump);
  disposables.push(watcher);
  // Lazy first build
  setTimeout(() => {
    try {
      buildRepoMap();
    } catch {
      /* ignore */
    }
  }, 2000);
}
