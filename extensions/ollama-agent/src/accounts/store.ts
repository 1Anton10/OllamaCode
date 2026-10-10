import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

export interface LocalAccountChatRef {
  id: string;
  title: string;
  updatedAt: string;
  preview?: string;
}

export interface LocalAccountWorkspaceRef {
  path: string;
  name: string;
  lastOpenedAt: string;
}

export interface LocalAccountRepoRef {
  path: string;
  remote?: string;
  branch?: string;
  lastSeenAt: string;
}

export interface LocalAccount {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
  chats: LocalAccountChatRef[];
  workspaces: LocalAccountWorkspaceRef[];
  repos: LocalAccountRepoRef[];
  prefs: {
    defaultModel?: string;
    thinking?: string;
  };
}

export interface AccountsIndex {
  version: 1;
  activeAccountId: string | null;
  accounts: Array<{ id: string; name: string; color: string }>;
}

const COLORS = ["#3b82f6", "#22c55e", "#eab308", "#ef4444", "#a855f7", "#06b6d4", "#f97316"];

function home(): string {
  return path.join(os.homedir(), ".ollamacode", "accounts");
}

function indexPath(): string {
  return path.join(home(), "index.json");
}

function accountDir(id: string): string {
  return path.join(home(), id);
}

function accountFile(id: string): string {
  return path.join(accountDir(id), "account.json");
}

function ensureRoot(): void {
  if (!fs.existsSync(home())) fs.mkdirSync(home(), { recursive: true });
}

function readJson<T>(p: string, fallback: T): T {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

export function loadIndex(): AccountsIndex {
  ensureRoot();
  return readJson<AccountsIndex>(indexPath(), {
    version: 1,
    activeAccountId: null,
    accounts: [],
  });
}

function saveIndex(idx: AccountsIndex): void {
  writeJson(indexPath(), idx);
}

export function loadAccount(id: string): LocalAccount | undefined {
  const p = accountFile(id);
  if (!fs.existsSync(p)) return undefined;
  return readJson<LocalAccount | undefined>(p, undefined);
}

export function saveAccount(acc: LocalAccount): void {
  acc.updatedAt = new Date().toISOString();
  writeJson(accountFile(acc.id), acc);
  const idx = loadIndex();
  const meta = idx.accounts.find((a) => a.id === acc.id);
  if (meta) {
    meta.name = acc.name;
    meta.color = acc.color;
  }
  saveIndex(idx);
}

export function getActiveAccount(): LocalAccount | undefined {
  const idx = loadIndex();
  if (!idx.activeAccountId) return undefined;
  return loadAccount(idx.activeAccountId);
}

export function listAccounts(): LocalAccount[] {
  const idx = loadIndex();
  return idx.accounts
    .map((m) => loadAccount(m.id))
    .filter((a): a is LocalAccount => !!a);
}

export function createAccount(name: string): LocalAccount {
  ensureRoot();
  const id = crypto.randomBytes(6).toString("hex");
  const idx = loadIndex();
  const color = COLORS[idx.accounts.length % COLORS.length];
  const now = new Date().toISOString();
  const acc: LocalAccount = {
    id,
    name: name.trim() || `User ${idx.accounts.length + 1}`,
    color,
    createdAt: now,
    updatedAt: now,
    chats: [],
    workspaces: [],
    repos: [],
    prefs: {},
  };
  fs.mkdirSync(accountDir(id), { recursive: true });
  writeJson(accountFile(id), acc);
  idx.accounts.push({ id, name: acc.name, color });
  idx.activeAccountId = id;
  saveIndex(idx);
  return acc;
}

export function ensureDefaultAccount(): LocalAccount {
  const idx = loadIndex();
  if (idx.activeAccountId) {
    const a = loadAccount(idx.activeAccountId);
    if (a) return a;
  }
  if (idx.accounts.length) {
    idx.activeAccountId = idx.accounts[0].id;
    saveIndex(idx);
    return loadAccount(idx.accounts[0].id)!;
  }
  const user = os.userInfo().username || "local";
  return createAccount(user);
}

export function switchAccount(id: string): LocalAccount | undefined {
  const acc = loadAccount(id);
  if (!acc) return undefined;
  const idx = loadIndex();
  idx.activeAccountId = id;
  saveIndex(idx);
  return acc;
}

export function renameAccount(id: string, name: string): LocalAccount | undefined {
  const acc = loadAccount(id);
  if (!acc) return undefined;
  acc.name = name.trim() || acc.name;
  saveAccount(acc);
  return acc;
}

export function deleteAccount(id: string): void {
  const idx = loadIndex();
  idx.accounts = idx.accounts.filter((a) => a.id !== id);
  if (idx.activeAccountId === id) {
    idx.activeAccountId = idx.accounts[0]?.id ?? null;
  }
  saveIndex(idx);
  const dir = accountDir(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

export function touchWorkspace(acc: LocalAccount, folderPath: string, name: string): void {
  const now = new Date().toISOString();
  const existing = acc.workspaces.find((w) => w.path === folderPath);
  if (existing) {
    existing.lastOpenedAt = now;
    existing.name = name;
  } else {
    acc.workspaces.unshift({ path: folderPath, name, lastOpenedAt: now });
  }
  acc.workspaces = acc.workspaces
    .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
    .slice(0, 30);
  saveAccount(acc);
}

export function touchRepo(
  acc: LocalAccount,
  repoPath: string,
  meta?: { remote?: string; branch?: string }
): void {
  const now = new Date().toISOString();
  const existing = acc.repos.find((r) => r.path === repoPath);
  if (existing) {
    existing.lastSeenAt = now;
    if (meta?.remote) existing.remote = meta.remote;
    if (meta?.branch) existing.branch = meta.branch;
  } else {
    acc.repos.unshift({
      path: repoPath,
      remote: meta?.remote,
      branch: meta?.branch,
      lastSeenAt: now,
    });
  }
  acc.repos = acc.repos.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, 40);
  saveAccount(acc);
}

export function upsertChat(
  acc: LocalAccount,
  chat: { id: string; title: string; preview?: string }
): void {
  const now = new Date().toISOString();
  const existing = acc.chats.find((c) => c.id === chat.id);
  if (existing) {
    existing.title = chat.title;
    existing.preview = chat.preview;
    existing.updatedAt = now;
  } else {
    acc.chats.unshift({
      id: chat.id,
      title: chat.title,
      preview: chat.preview,
      updatedAt: now,
    });
  }
  acc.chats = acc.chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100);
  saveAccount(acc);
}

export function accountDataDir(id: string): string {
  return accountDir(id);
}
