/**
 * Load Hub + workspace skills/rules into a system-prompt block.
 * Workspace `.github/skills` and `.cursor`/`.ollamacode` rules are first-class
 * (previously only Hub registry installs were loaded — so repo skills never reached the agent).
 */
import * as fs from "fs";
import * as path from "path";
import { loadRegistry } from "./registry";
import {
  rulesRoot,
  skillsRoot,
  workspaceRulesDir,
  workspaceSkillsDir,
} from "./paths";

const MAX_CHARS = 10_000;
const MAX_FILE_CHARS = 4_000;

/** Always keep these when present (core agent pipeline). */
const ALWAYS_ON = new Set([
  "app-dev-verify",
  "agent-discipline",
  "agent-orchestrate",
  "qwen-tools",
  "qwen-tool-calling",
]);

export interface SkillBlock {
  id: string;
  title: string;
  description: string;
  body: string;
  source: "workspace" | "hub" | "user";
  kind: "skill" | "rule";
}

export interface HubContextPack {
  text: string;
  skillCount: number;
  ruleCount: number;
  approxTokens: number;
  selectedIds?: string[];
}

function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function parseFrontmatter(md: string): { name?: string; description?: string; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { body: md.trim() };
  const meta = m[1];
  const body = (m[2] || "").trim();
  const name = meta.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = meta.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name, description, body };
}

function readCapped(fp: string): string | undefined {
  try {
    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return undefined;
    const raw = fs.readFileSync(fp, "utf8");
    if (!raw.trim()) return undefined;
    return raw.length > MAX_FILE_CHARS
      ? raw.slice(0, MAX_FILE_CHARS) + "\n…[truncated]"
      : raw;
  } catch {
    return undefined;
  }
}

function listMdFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(md|mdc|txt)$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function listImmediateSubdirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function resolveInstallDir(id: string, recPath?: string): string | undefined {
  if (recPath && fs.existsSync(recPath)) return recPath;
  for (const root of [skillsRoot(), rulesRoot()]) {
    const p = path.join(root, id);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function classifyKind(id: string, dir: string): "skill" | "rule" | null {
  if (id.startsWith("mcp-") || id.startsWith("link-")) return null;
  if (id.startsWith("rule-") || id.startsWith("gh-rule") || id.startsWith("hf-rule")) return "rule";
  if (id.startsWith("skill-") || id.startsWith("gh-") || id.startsWith("hf-skill") || id.startsWith("hf-")) {
    if (id.startsWith("hf-rule")) return "rule";
    return "skill";
  }
  const norm = dir.replace(/\\/g, "/").toLowerCase();
  if (norm.includes("/rules/")) return "rule";
  if (norm.includes("/skills/")) return "skill";
  if (listMdFiles(dir).some((f) => f.toLowerCase().endsWith(".mdc"))) return "rule";
  if (fs.existsSync(path.join(dir, "SKILL.md"))) return "skill";
  return "skill";
}

function cleanTitle(id: string): string {
  return id.replace(/^(skill-|gh-|hf-skill-|hf-|rule-|gh-rule-|hf-rule-)/, "");
}

function skillFromDir(
  dir: string,
  id: string,
  source: SkillBlock["source"]
): SkillBlock | undefined {
  const primaryPath = path.join(dir, "SKILL.md");
  const primary = readCapped(primaryPath);
  if (primary) {
    const parsed = parseFrontmatter(primary);
    return {
      id,
      title: parsed.name || cleanTitle(id),
      description: parsed.description || "",
      body: parsed.body || stripFrontmatter(primary),
      source,
      kind: "skill",
    };
  }
  for (const f of listMdFiles(dir)) {
    const t = readCapped(f);
    if (!t) continue;
    const parsed = parseFrontmatter(t);
    return {
      id,
      title: parsed.name || path.basename(f, path.extname(f)),
      description: parsed.description || "",
      body: parsed.body || stripFrontmatter(t),
      source,
      kind: "skill",
    };
  }
  return undefined;
}

function rulesFromDir(
  dir: string,
  idPrefix: string,
  source: SkillBlock["source"]
): SkillBlock[] {
  const out: SkillBlock[] = [];
  for (const f of listMdFiles(dir)) {
    const raw = readCapped(f);
    if (!raw) continue;
    const parsed = parseFrontmatter(raw);
    const base = path.basename(f).replace(/\.mdc?$/i, "");
    out.push({
      id: `${idPrefix}/${base}`,
      title: parsed.name || base,
      description: parsed.description || "",
      body: parsed.body || stripFrontmatter(raw),
      source,
      kind: "rule",
    });
  }
  return out;
}

/** Collect all candidate skills/rules (workspace + user home + Hub). */
export function collectAllSkillBlocks(): SkillBlock[] {
  const byId = new Map<string, SkillBlock>();
  const put = (b: SkillBlock) => {
    // Dedup by skill/rule name (strip path prefixes like ws-rule/, user-rule/)
    const key = cleanTitle(b.title || b.id)
      .replace(/^(ws-rule|user-rule|cursor-rule|rule)\//i, "")
      .toLowerCase();
    const prev = byId.get(key);
    const rank = (s: SkillBlock["source"]) =>
      s === "workspace" ? 3 : s === "user" ? 2 : 1;
    if (!prev || rank(b.source) > rank(prev.source)) {
      byId.set(key, b);
    }
  };

  // 1) Workspace .github/skills/<name>/SKILL.md (one skill per folder)
  const wsSkills = workspaceSkillsDir();
  if (wsSkills) {
    for (const dir of listImmediateSubdirs(wsSkills)) {
      const id = path.basename(dir);
      const block = skillFromDir(dir, id, "workspace");
      if (block) put(block);
    }
  }

  // 2) Workspace rules: .ollamacode/rules + .cursor/rules
  const wsRules = workspaceRulesDir();
  if (wsRules && fs.existsSync(wsRules)) {
    for (const r of rulesFromDir(wsRules, "ws-rule", "workspace")) put(r);
  }
  // Also pick .cursor/rules when workspaceRulesDir returned .ollamacode/rules
  if (wsSkills) {
    const wsRoot = path.dirname(path.dirname(wsSkills));
    const cursorRules = path.join(wsRoot, ".cursor", "rules");
    if (fs.existsSync(cursorRules) && cursorRules !== wsRules) {
      for (const r of rulesFromDir(cursorRules, "cursor-rule", "workspace")) put(r);
    }
  }

  // 3) User home skills/rules dirs (manual installs)
  for (const dir of listImmediateSubdirs(skillsRoot())) {
    const id = path.basename(dir);
    const block = skillFromDir(dir, id, "user");
    if (block) put(block);
  }
  for (const r of rulesFromDir(rulesRoot(), "user-rule", "user")) put(r);

  // 4) Hub registry (enabled installs)
  try {
    const reg = loadRegistry();
    for (const [id, rec] of Object.entries(reg.items || {})) {
      if (!rec?.installed || !rec.enabled) continue;
      const dir = resolveInstallDir(id, rec.path);
      if (!dir) continue;
      const kind = classifyKind(id, dir);
      if (!kind) continue;
      if (kind === "skill") {
        const block = skillFromDir(dir, id, "hub");
        if (block) put(block);
      } else {
        for (const r of rulesFromDir(dir, id, "hub")) put(r);
      }
    }
  } catch {
    /* registry optional */
  }

  return [...byId.values()];
}

function tokenize(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

/**
 * Score skill relevance to the current user ask.
 * Always-on core skills score high; others need keyword overlap.
 */
export function scoreSkillRelevance(block: SkillBlock, userText: string): number {
  const title = cleanTitle(block.id).toLowerCase();
  if (ALWAYS_ON.has(title) || ALWAYS_ON.has(block.title.toLowerCase())) {
    return 1000;
  }
  if (block.kind === "rule") {
    // Rules always apply lightly — keep them but they don't dominate
    return 80;
  }
  const blob = `${block.title} ${block.description} ${block.body.slice(0, 800)}`.toLowerCase();
  const q = tokenize(userText);
  if (!q.length) return 40;
  let score = 0;
  for (const w of q) {
    if (blob.includes(w)) score += 12;
  }
  // Orchestration only when task looks multi-step / parallel
  if (/orchestrat|subagent|сабагент|параллел|parallel|несколько\s+задач/i.test(userText)) {
    if (/orchestrat|subagent|сабагент/i.test(blob)) score += 60;
  } else if (/orchestrat/i.test(title)) {
    score -= 30; // demote unless asked
  }
  // Plan skill for action requests
  if (/создай|исправ|почин|напиши|сделай|implement|fix|create|write/i.test(userText)) {
    if (/plan-then-act|plan then/i.test(title + block.description)) score += 40;
  }
  // Desktop / bot → keep app-dev-verify (already always-on) and related
  if (/telegram|бот|gui|windows_desktop|desktop/i.test(userText)) {
    if (/verify|desktop|bot|windows/i.test(blob)) score += 25;
  }
  return score;
}

function selectBlocks(all: SkillBlock[], userText: string, maxChars: number): SkillBlock[] {
  const scored = all
    .map((b) => ({ b, score: scoreSkillRelevance(b, userText) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const picked: SkillBlock[] = [];
  let used = 0;
  // Header budget
  const headerBudget = 120;
  used += headerBudget;

  for (const { b, score } of scored) {
    // Soft gate: non-core skills need some relevance unless few candidates
    const title = cleanTitle(b.id).toLowerCase();
    const isCore = ALWAYS_ON.has(title) || b.kind === "rule";
    if (!isCore && score < 24 && picked.length >= 2) continue;
    const chunk =
      b.kind === "skill"
        ? `\n### Skill: ${b.title}\n${b.body}\n`
        : `\n### Rule: ${b.title}\n${b.body}\n`;
    if (used + chunk.length > maxChars) {
      // Try truncated body for core only
      if (isCore && b.body.length > 600) {
        const short = `\n### Skill: ${b.title}\n${b.body.slice(0, 600)}\n…[truncated]\n`;
        if (used + short.length <= maxChars) {
          picked.push({ ...b, body: b.body.slice(0, 600) + "\n…[truncated]" });
          used += short.length;
        }
      }
      continue;
    }
    picked.push(b);
    used += chunk.length;
  }
  return picked;
}

export interface BuildHubContextPackOpts {
  maxChars?: number;
  /** Current user message — used for relevance routing (Cursor-like densify). */
  userText?: string;
}

/** Build [SKILLS]/[RULES] block from workspace + Hub installs. */
export function buildHubContextPack(
  maxCharsOrOpts: number | BuildHubContextPackOpts = MAX_CHARS
): HubContextPack {
  const opts: BuildHubContextPackOpts =
    typeof maxCharsOrOpts === "number" ? { maxChars: maxCharsOrOpts } : maxCharsOrOpts || {};
  const maxChars = opts.maxChars ?? MAX_CHARS;
  const userText = opts.userText || "";

  const all = collectAllSkillBlocks();
  const selected = selectBlocks(all, userText, maxChars);

  const skills = selected.filter((s) => s.kind === "skill");
  const rules = selected.filter((s) => s.kind === "rule");

  const parts: string[] = [];
  if (skills.length) {
    parts.push(
      "## Active Skills (follow when relevant — do not narrate the skill, just execute the pipeline)\n"
    );
    for (const s of skills) {
      parts.push(`\n### Skill: ${s.title}\n${s.body}\n`);
    }
  }
  if (rules.length) {
    parts.push("\n## Active Rules (always apply)\n");
    for (const r of rules) {
      parts.push(`\n### Rule: ${r.title}\n${r.body}\n`);
    }
  }

  const text = parts.join("").trim();
  return {
    text,
    skillCount: skills.length,
    ruleCount: rules.length,
    approxTokens: Math.max(0, Math.ceil(text.length / 4)),
    selectedIds: selected.map((s) => s.id),
  };
}
