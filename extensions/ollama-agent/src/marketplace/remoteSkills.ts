/**
 * Remote Hub catalog: skills / rules / MCP packs from GitHub and Hugging Face.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { MarketplaceItem } from "./types";
import { ensureDir, ollamaCodeHome } from "./paths";

export interface PackSource {
  /** owner/repo (GitHub) or org/name (HF) */
  repo: string;
  /** subdirectory, empty = root */
  root: string;
  label: string;
  host: "github" | "hf";
  /** Force kind for every folder; auto = detect from files */
  kindHint?: "skill" | "rule" | "mcp" | "auto";
}

const DEFAULT_SKILL_SOURCES: PackSource[] = [
  { repo: "anthropics/skills", root: "skills", label: "Anthropic", host: "github", kindHint: "skill" },
];

const DEFAULT_RULE_SOURCES: PackSource[] = [];

const DEFAULT_MCP_SOURCES: PackSource[] = [
  {
    repo: "modelcontextprotocol/servers",
    root: "src",
    label: "MCP Official",
    host: "github",
    kindHint: "mcp",
  },
];

const CLOUD_ONLY = /^(claude-api)$/i;

function cachePath(): string {
  return path.join(ollamaCodeHome(), "marketplace", "remote-catalog-cache.json");
}

function parseSource(
  spec: string,
  host: "github" | "hf",
  kindHint?: PackSource["kindHint"]
): PackSource | undefined {
  const s = spec.trim();
  if (!s) return undefined;
  // optional prefix hf: or github:
  let h = host;
  let rest = s;
  if (/^hf:/i.test(s)) {
    h = "hf";
    rest = s.slice(3);
  } else if (/^github:/i.test(s)) {
    h = "github";
    rest = s.slice(7);
  }
  const m = rest.match(/^([^/\s]+)\/([^/\s:]+)(?::(.+))?$/);
  if (!m) return undefined;
  const root = (m[3] || "").replace(/^\/+|\/+$/g, "");
  return {
    repo: `${m[1]}/${m[2]}`,
    root,
    label: m[1],
    host: h,
    kindHint: kindHint || "auto",
  };
}

export function configuredPackSources(): PackSource[] {
  const cfg = vscode.workspace.getConfiguration("ollamaCode");
  const skills = (cfg.get<string[]>("skillSources", ["anthropics/skills:skills"]) || [])
    .map((s) => parseSource(s, "github", "skill"))
    .filter((x): x is PackSource => !!x);
  const rules = (cfg.get<string[]>("ruleSources", []) || [])
    .map((s) => parseSource(s, "github", "rule"))
    .filter((x): x is PackSource => !!x);
  const mcps = (cfg.get<string[]>("mcpSources", ["modelcontextprotocol/servers:src"]) || [])
    .map((s) => parseSource(s, "github", "mcp"))
    .filter((x): x is PackSource => !!x);
  const hf = (cfg.get<string[]>("hfPackSources", []) || [])
    .map((s) => parseSource(s, "hf", "auto"))
    .filter((x): x is PackSource => !!x);

  const out = [
    ...(skills.length ? skills : DEFAULT_SKILL_SOURCES),
    ...(rules.length ? rules : DEFAULT_RULE_SOURCES),
    ...(mcps.length ? mcps : DEFAULT_MCP_SOURCES),
    ...hf,
  ];
  // de-dupe by host+repo+root
  const seen = new Set<string>();
  return out.filter((s) => {
    const k = `${s.host}:${s.repo}:${s.root}:${s.kindHint}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const block = m[1];
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name, description };
}

function inferTags(name: string, description: string): string[] {
  const t = `${name} ${description}`.toLowerCase();
  const tags = new Set<string>(["general", "agent"]);
  if (/code|dev|git|test|mcp|frontend|web|api|debug|refactor/.test(t)) {
    tags.add("coder");
    tags.add("tools");
  }
  if (/design|brand|theme|art|pptx|pdf|docx|xlsx|gif|canvas/.test(t)) tags.add("coder");
  if (/qwen|ollama|local/.test(t)) {
    tags.add("qwen");
    tags.add("tools");
  }
  if (/rule|style|lint|convention/.test(t)) tags.add("coder");
  return [...tags];
}

function titleCase(s: string): string {
  return s
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function githubToken(): string {
  return (
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    vscode.workspace.getConfiguration("ollamaCode").get<string>("githubToken") ||
    ""
  ).trim();
}

function hfToken(): string {
  return (
    process.env.HF_TOKEN ||
    process.env.HUGGING_FACE_HUB_TOKEN ||
    vscode.workspace.getConfiguration("ollamaCode").get<string>("hfToken") ||
    ""
  ).trim();
}

/** Host-specific auth — never send HF token to GitHub (causes HTTP 401). */
function authHeaders(host: "github" | "hf" | "raw", json: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "OllamaCode-Hub/1.0",
  };
  if (json && host === "github") {
    headers.Accept = "application/vnd.github+json";
    headers["X-GitHub-Api-Version"] = "2022-11-28";
  } else if (json) {
    headers.Accept = "application/json";
  }
  if (host === "github") {
    const token = githubToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  } else if (host === "hf") {
    const token = hfToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  // raw.githubusercontent.com / public CDN — no Authorization
  return headers;
}

async function httpJson<T>(url: string, host: "github" | "hf"): Promise<T> {
  const res = await fetch(url, { headers: authHeaders(host, true) });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`HTTP ${res.status}: ${url}${body ? " — " + body : ""}`);
  }
  return (await res.json()) as T;
}

async function httpText(url: string, host: "github" | "hf" | "raw" = "raw"): Promise<string> {
  const res = await fetch(url, { headers: authHeaders(host, false) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** GitHub Contents API with unauthenticated fallback (bad/expired tokens → 401). */
async function githubContents(apiUrl: string): Promise<GhEntry[]> {
  try {
    return await httpJson<GhEntry[]>(apiUrl, "github");
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (!/HTTP 401|HTTP 403/.test(msg)) throw e;
    // Public repos work without auth; invalid GITHUB_TOKEN/HF mix used to break this
    const res = await fetch(apiUrl, {
      headers: {
        "User-Agent": "OllamaCode-Hub/1.0",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.ok) return (await res.json()) as GhEntry[];
    const body = (await res.text().catch(() => "")).slice(0, 160);
    throw new Error(`HTTP ${res.status}: ${apiUrl}${body ? " — " + body : ""}`);
  }
}

interface GhEntry {
  name: string;
  type: string;
  path: string;
}

interface HfEntry {
  type: string;
  path: string;
}

async function listFolders(source: PackSource): Promise<string[]> {
  if (source.host === "github") {
    const apiPath = source.root
      ? `https://api.github.com/repos/${source.repo}/contents/${source.root}`
      : `https://api.github.com/repos/${source.repo}/contents`;
    const entries = await githubContents(apiPath);
    return entries.filter((e) => e.type === "dir" && !e.name.startsWith(".")).map((e) => e.name);
  }
  // HF: list tree (dataset or model)
  const treeUrls = [
    `https://huggingface.co/api/datasets/${source.repo}/tree/main${source.root ? "/" + source.root : ""}`,
    `https://huggingface.co/api/models/${source.repo}/tree/main${source.root ? "/" + source.root : ""}`,
  ];
  let entries: HfEntry[] = [];
  let lastErr: Error | undefined;
  for (const url of treeUrls) {
    try {
      entries = await httpJson<HfEntry[]>(url, "hf");
      lastErr = undefined;
      break;
    } catch (e: any) {
      lastErr = e;
    }
  }
  if (lastErr && !entries.length) throw lastErr;
  // HF tree may be flat files — group by top-level folder under root
  const folders = new Set<string>();
  const filesAtRoot: string[] = [];
  for (const e of entries) {
    const rel = source.root && e.path.startsWith(source.root + "/")
      ? e.path.slice(source.root.length + 1)
      : e.path;
    if (!rel || rel.startsWith(".")) continue;
    if (e.type === "directory") {
      folders.add(rel.split("/")[0]);
    } else {
      const parts = rel.split("/");
      if (parts.length === 1) filesAtRoot.push(parts[0]);
      else folders.add(parts[0]);
    }
  }
  if (!folders.size && filesAtRoot.some((f) => /\.(md|mdc)$/i.test(f))) {
    return [""]; // treat pack root as single item
  }
  return [...folders];
}

async function loadMeta(
  source: PackSource,
  folder: string
): Promise<{ name?: string; description?: string; kind: "skill" | "rule" | "mcp"; files: string[] }> {
  const basePath = [source.root, folder].filter(Boolean).join("/");
  const files: string[] = [];
  let kind: "skill" | "rule" | "mcp" =
    source.kindHint && source.kindHint !== "auto" ? source.kindHint : "skill";

  if (source.host === "github") {
    const api = basePath
      ? `https://api.github.com/repos/${source.repo}/contents/${basePath}`
      : `https://api.github.com/repos/${source.repo}/contents`;
    try {
      const entries = await githubContents(api);
      for (const e of entries) {
        if (e.type === "file") files.push(e.name);
      }
    } catch {
      /* ignore */
    }
  } else {
    const urls = [
      `https://huggingface.co/api/datasets/${source.repo}/tree/main${basePath ? "/" + basePath : ""}`,
      `https://huggingface.co/api/models/${source.repo}/tree/main${basePath ? "/" + basePath : ""}`,
    ];
    for (const url of urls) {
      try {
        const entries = await httpJson<HfEntry[]>(url, "hf");
        for (const e of entries) {
          if (e.type === "file") {
            const name = e.path.split("/").pop() || e.path;
            files.push(name);
          }
        }
        break;
      } catch {
        /* try next */
      }
    }
  }

  if (source.kindHint === "auto" || !source.kindHint) {
    if (files.some((f) => /\.mdc$/i.test(f)) || files.some((f) => /^RULE/i.test(f))) kind = "rule";
    else if (files.includes("package.json") || files.includes("server.py") || files.includes("index.ts"))
      kind = "mcp";
    else kind = "skill";
  }

  let meta: { name?: string; description?: string } = {};
  const skillCandidates = ["SKILL.md", "README.md", "rule.md", "RULE.md"];
  for (const cand of skillCandidates) {
    if (!files.includes(cand) && kind !== "rule") continue;
    const text = await fetchRaw(source, basePath, cand);
    if (!text) continue;
    meta = parseFrontmatter(text);
    if (!meta.description && text) {
      const first = text
        .replace(/^---[\s\S]*?---/, "")
        .trim()
        .split("\n")
        .find((l) => l.trim() && !l.startsWith("#"));
      if (first) meta.description = first.slice(0, 160);
    }
    if (meta.name || meta.description) break;
  }
  // rules: any .mdc
  if (kind === "rule" && !meta.description) {
    const mdc = files.find((f) => /\.mdc$/i.test(f));
    if (mdc) {
      const text = await fetchRaw(source, basePath, mdc);
      if (text) meta = { ...meta, ...parseFrontmatter(text) };
    }
  }

  return { ...meta, kind, files };
}

async function fetchRaw(source: PackSource, basePath: string, file: string): Promise<string | undefined> {
  const rel = [basePath, file].filter(Boolean).join("/");
  if (source.host === "github") {
    for (const branch of ["main", "master"]) {
      try {
        return await httpText(
          `https://raw.githubusercontent.com/${source.repo}/${branch}/${rel}`,
          "raw"
        );
      } catch {
        /* next */
      }
    }
    return undefined;
  }
  for (const prefix of ["datasets", "models"]) {
    try {
      return await httpText(
        `https://huggingface.co/${prefix}/${source.repo}/resolve/main/${rel}`,
        "hf"
      );
    } catch {
      /* next */
    }
  }
  return undefined;
}

function toItem(
  source: PackSource,
  folder: string,
  meta: Awaited<ReturnType<typeof loadMeta>>
): MarketplaceItem | undefined {
  const folderKey = folder || "root";
  if (CLOUD_ONLY.test(folderKey)) return undefined;
  // Skip MCP official packages that need heavy deps / are duplicates of bundled npm ids
  if (meta.kind === "mcp" && /^(everything|memory)$/i.test(folderKey) === false) {
    // allow most official servers
  }

  const packPath = [source.root, folder].filter(Boolean).join("/");
  const name = meta.name || titleCase(folderKey);
  const description =
    meta.description ||
    `${meta.kind} from ${source.host}:${source.repo}${packPath ? "/" + packPath : ""}`;
  const prefix =
    source.host === "hf"
      ? meta.kind === "rule"
        ? "hf-rule"
        : meta.kind === "mcp"
          ? "hf-mcp"
          : "hf-skill"
      : meta.kind === "rule"
        ? "gh-rule"
        : meta.kind === "mcp"
          ? "gh-mcp"
          : "gh";
  const id = `${prefix}-${source.repo.replace("/", "-")}-${folderKey}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-");

  const item: MarketplaceItem = {
    id,
    kind: meta.kind,
    name,
    description,
    source: `${source.host}:${source.repo}/${packPath || ""}`,
    region: ["global"],
    popularity: source.host === "github" ? 55 : 50,
    modelTags: inferTags(name, description),
    fit: "optional",
    defaultInstall: false,
    install: {
      type: "git-sparse",
      repo:
        source.host === "github"
          ? `https://github.com/${source.repo}.git`
          : `https://huggingface.co/${source.repo}`,
      paths: packPath ? [packPath] : ["."],
    },
  };

  if (meta.kind === "mcp") {
    const key = `ollamacode-git-${folderKey}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    item.mcp = {
      key,
      command: "npx",
      args: ["-y", `@modelcontextprotocol/server-${folderKey}`],
    };
    // Official npm packages — no git clone needed
    if (source.repo === "modelcontextprotocol/servers") {
      delete item.install;
    }
  }

  return item;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

export async function fetchRemoteCatalog(opts?: { force?: boolean }): Promise<{
  items: MarketplaceItem[];
  fromCache: boolean;
  error?: string;
  counts: { skill: number; rule: number; mcp: number };
}> {
  ensureDir(path.dirname(cachePath()));
  const ttlMs = 6 * 60 * 60 * 1000;
  if (!opts?.force && fs.existsSync(cachePath())) {
    try {
      const raw = JSON.parse(fs.readFileSync(cachePath(), "utf8")) as {
        at: number;
        items: MarketplaceItem[];
      };
      if (Date.now() - raw.at < ttlMs && Array.isArray(raw.items)) {
        return {
          items: raw.items,
          fromCache: true,
          counts: countKinds(raw.items),
        };
      }
    } catch {
      /* refresh */
    }
  }

  const sources = configuredPackSources();
  const items: MarketplaceItem[] = [];
  const errors: string[] = [];

  for (const source of sources) {
    try {
      const folders = await listFolders(source);
      const metas = await mapPool(folders, 5, (folder) => loadMeta(source, folder));
      for (let i = 0; i < folders.length; i++) {
        const item = toItem(source, folders[i], metas[i]);
        if (item) items.push(item);
      }
    } catch (e: any) {
      errors.push(`${source.host}:${source.repo}: ${e?.message || e}`);
    }
  }

  if (items.length) {
    fs.writeFileSync(
      cachePath(),
      JSON.stringify({ at: Date.now(), items, sources }, null, 2),
      "utf8"
    );
  }

  return {
    items,
    fromCache: false,
    error: errors.length ? errors.join("; ") : undefined,
    counts: countKinds(items),
  };
}

function countKinds(items: MarketplaceItem[]) {
  return {
    skill: items.filter((i) => i.kind === "skill").length,
    rule: items.filter((i) => i.kind === "rule").length,
    mcp: items.filter((i) => i.kind === "mcp").length,
  };
}

/** @deprecated use fetchRemoteCatalog */
export async function fetchRemoteSkills(opts?: { force?: boolean }) {
  const r = await fetchRemoteCatalog(opts);
  return {
    items: r.items,
    fromCache: r.fromCache,
    error: r.error,
  };
}

export function mergeCatalog(
  bundled: MarketplaceItem[],
  remote: MarketplaceItem[]
): MarketplaceItem[] {
  const seen = new Set(bundled.map((i) => i.id));
  const out = [...bundled];
  for (const r of remote) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}
