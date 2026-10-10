/**
 * Chunked / virtual context (OmniSlots-style).
 *
 * Quality rules:
 * - Recent turns stay FULL (never mashed).
 * - Older turns archived as discrete JSON slots (one message = one slot).
 * - Auto-inject only clear SEPARATED excerpts; full text via vctx_recall tool.
 * - Digest is an INDEX of titles, not a smashed paragraph of content.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChatMessage } from "../ollama/client";

export interface ChunkPackOptions {
  windowTokens: number;
  virtualTargetTokens?: number;
  userText: string;
  systemPrompt: string;
  persistSlots?: boolean;
  sessionKey?: string;
}

export interface ChunkPackResult {
  messages: ChatMessage[];
  usedTokens: number;
  rawTokens: number;
  virtualTokens: number;
  packed: boolean;
  note: string;
  hitRate?: number;
}

export interface VctxSlotMeta {
  id: string;
  file: string;
  role: string;
  tool_name?: string;
  tokens: number;
  chars: number;
  preview: string;
  turn: number;
}

export interface VctxRecallHit {
  id: string;
  role: string;
  tool_name?: string;
  score: number;
  truncated: boolean;
  content: string;
}

let activeSessionKey = "default";

export function setVctxSessionKey(key: string): void {
  activeSessionKey = (key || "default").replace(/[^\w.-]+/g, "_").slice(0, 64);
}

export function getVctxSessionKey(): string {
  return activeSessionKey;
}

const STOP = new Set([
  "the", "this", "that", "with", "from", "into", "your", "you", "and", "are", "for",
  "not", "but", "was", "were", "have", "has", "had", "для", "как", "или", "что",
  "это", "при", "без", "над", "под", "если", "тогда", "только", "уже", "ещё", "еще",
  "очень", "можно", "нужно", "надо", "есть", "был", "была", "были", "быть", "тоже",
  "также", "просто", "через", "после", "перед",
]);

function tok(s: string): number {
  return Math.max(1, Math.ceil((s || "").length / 4));
}

function msgTok(m: ChatMessage): number {
  let n = tok(m.content || "") + tok(m.thinking || "") + 8;
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
    try {
      n += tok(JSON.stringify(m.tool_calls));
    } catch {
      n += 64 * m.tool_calls.length;
    }
  }
  return n;
}

/** Rough token count for an in-flight agent history (incl. tool_calls). */
export function estimateHistoryTokens(messages: ChatMessage[]): number {
  return messages.reduce((a, m) => a + msgTok(m), 0);
}

/**
 * Qwen 3.5/3.6/3.8 chat templates require ≥1 role:user whose text is NOT wrapped in
 * `<tool_response>…</tool_response>`. Tool roles never count. After VCTX pack, recent
 * turns are often only assistant/tool — that 500s with "No user query found in messages."
 */
export function isPlainUserQuery(content: string): boolean {
  const c = String(content || "").trim();
  if (!c) return false;
  if (c.startsWith("<tool_response>") && c.endsWith("</tool_response>")) return false;
  return true;
}

export function hasPlainUserQuery(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === "user" && isPlainUserQuery(m.content || ""));
}

const TASK_PIN = "[task]";

/** Mutates messages: pin the live task as a plain user turn after systems if missing. */
export function ensurePlainUserQuery(messages: ChatMessage[], userText: string): boolean {
  if (hasPlainUserQuery(messages)) return false;
  const task = String(userText || "").trim() || "Continue the current task with tools as needed.";
  let insertAt = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "system") insertAt = i + 1;
    else break;
  }
  messages.splice(insertAt, 0, {
    role: "user",
    content: task.length > 4000 ? task.slice(0, 4000) + "…" : task,
  });
  return true;
}

/**
 * Ollama drops messages from the FRONT when over num_ctx and only guarantees the LAST
 * message survives. If the last turn is `tool`, prune can leave zero plain `user` → Qwen 500.
 * Pin a tiny continue marker at the END — do NOT re-send the full user question every tool.
 */
export function pinTaskAtEnd(messages: ChatMessage[], userText: string): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = String(messages[i].content || "");
    if (messages[i].role === "user" && c.startsWith(TASK_PIN)) {
      messages.splice(i, 1);
    }
  }
  const last = messages[messages.length - 1];
  // Already ends with a real user turn — that survives prune; no duplicate ask.
  if (last?.role === "user" && isPlainUserQuery(last.content || "")) {
    return;
  }
  const hasEarlierUser = messages.some(
    (m) =>
      m.role === "user" &&
      isPlainUserQuery(m.content || "") &&
      !String(m.content || "").startsWith(TASK_PIN)
  );
  const task = String(userText || "").trim().slice(0, 1500) || "Continue the current task with tools.";
  messages.push({
    role: "user",
    // Short anchor when history already has the real ask — model "remembers" via history.
    // Do NOT repeat the full user question (that triggers Qwen «user wants → plan» loops).
    content: hasEarlierUser
      ? `${TASK_PIN}\nnext — act on last TOOL_RESULT; do not restate the user goal`
      : `${TASK_PIN}\n${task}`,
  });
}

/** Cap tool/user-nudge blobs so Ollama front-pruning keeps the pinned user turn. */
export function shrinkHeavyMessages(messages: ChatMessage[], maxChars = 2500): number {
  let n = 0;
  for (const m of messages) {
    if (m.role !== "tool" && !(m.role === "user" && String(m.content || "").startsWith("[system]"))) {
      continue;
    }
    const c = String(m.content || "");
    if (c.length <= maxChars) continue;
    const head = Math.floor(maxChars * 0.7);
    const tail = Math.max(80, maxChars - head - 40);
    m.content =
      c.slice(0, head) +
      `\n…[trimmed ${c.length - maxChars} chars for context]…\n` +
      c.slice(-tail);
    n += 1;
  }
  return n;
}

/**
 * Qwen 3.5+ templates: ONLY the first message may be role=system.
 * Extra system turns (VCTX block, nudges) → Jinja 500 "System message must be at the beginning."
 * Merge all systems into messages[0]; demote any later ones to user.
 */
export function normalizeMessagesForQwen(messages: ChatMessage[]): void {
  if (!messages.length) return;
  const systems: string[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      const c = String(m.content || "").trim();
      if (c) systems.push(c);
      continue;
    }
    rest.push(m);
  }
  messages.length = 0;
  if (systems.length) {
    messages.push({ role: "system", content: systems.join("\n\n") });
  }
  messages.push(...rest);
}

/** Before every Ollama call: shrink tools + pin task + single leading system. */
export function prepareMessagesForQwen(messages: ChatMessage[], userText: string, maxToolChars = 2200): void {
  shrinkHeavyMessages(messages, maxToolChars);
  ensurePlainUserQuery(messages, userText);
  pinTaskAtEnd(messages, userText);
  normalizeMessagesForQwen(messages);
}

/**
 * Mid-turn compact: when agent tool results blow past physical num_ctx,
 * re-pack into VCTX slots so Ollama never sees a 32k KV inflate.
 * Mutates `history` in place. Returns whether a pack happened.
 */
export function compactMessagesInPlace(
  history: ChatMessage[],
  opts: {
    numCtx: number;
    virtualCtx?: number;
    userText: string;
    sessionKey?: string;
  }
): { compacted: boolean; note: string; usedTokens: number; virtualTokens: number } {
  const numCtx = Math.max(2048, opts.numCtx || 8192);
  const windowTokens = Math.max(1024, numCtx - Math.min(2048, Math.floor(numCtx / 4)));
  const used = estimateHistoryTokens(history);
  // Cursor-like: auto-compact when physical window is ~80% full (repeatable every round).
  if (used <= Math.floor(windowTokens * 0.8)) {
    return {
      compacted: false,
      note: "",
      usedTokens: used,
      virtualTokens: Math.min(opts.virtualCtx || 32768, used),
    };
  }
  const sys = history.find(
    (m) => m.role === "system" && !String(m.content || "").startsWith("[VCTX")
  );
  const packed = packChunkedContext(history, {
    windowTokens,
    virtualTargetTokens: opts.virtualCtx || 32768,
    userText: opts.userText,
    systemPrompt: sys?.content || "",
    persistSlots: true,
    sessionKey: opts.sessionKey,
  });
  if (!packed.packed) {
    return {
      compacted: false,
      note: packed.note,
      usedTokens: packed.usedTokens,
      virtualTokens: packed.virtualTokens,
    };
  }
  history.length = 0;
  history.push(...packed.messages);
  ensurePlainUserQuery(history, opts.userText);
  return {
    compacted: true,
    note: packed.note,
    usedTokens: estimateHistoryTokens(history),
    virtualTokens: packed.virtualTokens,
  };
}

function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of (text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 3 && !STOP.has(t))) {
    out.add(w);
  }
  return out;
}

function scoreChunk(askTerms: Set<string>, text: string, role?: string): number {
  if (!askTerms.size) return 0;
  const t = terms(text);
  let overlap = 0;
  for (const w of askTerms) if (t.has(w)) overlap++;
  let score = overlap * 2;
  if (role === "tool") score += 0.35;
  if (role === "user") score += 0.2;
  for (const w of askTerms) {
    if (/\.(ts|js|py|json|md|tsx|css)$/i.test(w) && text.toLowerCase().includes(w)) score += 0.8;
  }
  return score;
}

function slotDir(sessionKey?: string): string {
  const safe = (sessionKey || activeSessionKey || "default").replace(/[^\w.-]+/g, "_").slice(0, 64);
  return path.join(os.homedir(), ".ollamacode", "vctx", safe);
}

function previewOf(content: string, n = 120): string {
  return (content || "").replace(/\s+/g, " ").trim().slice(0, n);
}

function titleOf(m: ChatMessage, turn: number): string {
  const role = m.role || "?";
  const tool = m.tool_name ? `/${m.tool_name}` : "";
  return `#${turn} ${role}${tool}: ${previewOf(m.content || "", 100)}`;
}

/** Store one message as a discrete lossless slot (JSON). Dedupes by content hash. */
function persistSlot(
  sessionKey: string,
  m: ChatMessage,
  turn: number,
  seen: Set<string>
): VctxSlotMeta | null {
  const dir = slotDir(sessionKey);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  const body = (m.content || "").trim();
  if (!body) return null;
  const key = `${m.role}|${m.tool_name || ""}|${body.slice(0, 200)}|${body.length}`;
  if (seen.has(key)) return null;
  seen.add(key);

  const id = `t${turn}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const file = `slot_${id}.json`;
  const record = {
    id,
    role: m.role || "unknown",
    tool_name: m.tool_name,
    turn,
    content: body,
    thinking: m.thinking || undefined,
  };
  try {
    fs.writeFileSync(path.join(dir, file), JSON.stringify(record, null, 2), "utf8");
    const meta: VctxSlotMeta = {
      id,
      file,
      role: record.role,
      tool_name: m.tool_name,
      tokens: tok(body),
      chars: body.length,
      preview: previewOf(body, 140),
      turn,
    };
    fs.appendFileSync(path.join(dir, "index.jsonl"), JSON.stringify(meta) + "\n", "utf8");
    return meta;
  } catch {
    return null;
  }
}

function loadIndex(sessionKey?: string): VctxSlotMeta[] {
  const indexPath = path.join(slotDir(sessionKey), "index.jsonl");
  if (!fs.existsSync(indexPath)) return [];
  try {
    return fs
      .readFileSync(indexPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-8000)
      .map((line) => {
        try {
          return JSON.parse(line) as VctxSlotMeta;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as VctxSlotMeta[];
  } catch {
    return [];
  }
}

function readSlotFull(sessionKey: string | undefined, meta: VctxSlotMeta): string {
  const fp = path.join(slotDir(sessionKey), meta.file);
  try {
    const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as {
      content?: string;
      role?: string;
      tool_name?: string;
      id?: string;
    };
    return raw.content || "";
  } catch {
    // legacy .txt slots
    const txt = path.join(slotDir(sessionKey), meta.file);
    try {
      return fs.readFileSync(txt, "utf8");
    } catch {
      return "";
    }
  }
}

/** Bounded excerpt with clear fences — never glue two messages. */
function formatExcerpt(
  id: string,
  role: string,
  tool: string | undefined,
  content: string,
  maxChars: number
): { text: string; truncated: boolean } {
  const full = content || "";
  const truncated = full.length > maxChars;
  let body = full;
  if (truncated) {
    const head = Math.floor(maxChars * 0.7);
    const tail = Math.max(80, maxChars - head - 40);
    body =
      full.slice(0, head) +
      `\n…[TRUNCATED ${full.length - maxChars} chars — call vctx_recall id="${id}" for FULL]…\n` +
      full.slice(-tail);
  }
  const toolBit = tool ? ` tool=${tool}` : "";
  return {
    truncated,
    text:
      `<<<VCTX id="${id}" role=${role}${toolBit} chars=${full.length} truncated=${truncated}>>>\n` +
      body +
      `\n<<<END VCTX id="${id}">>>`,
  };
}

/**
 * Model-facing recall: search / fetch discrete slots. Never merges bodies.
 */
export function vctxRecall(opts: {
  query?: string;
  ids?: string[];
  maxItems?: number;
  maxCharsPerItem?: number;
  sessionKey?: string;
}): { ok: true; hits: VctxRecallHit[]; indexSize: number; note: string } | { ok: false; error: string } {
  const sessionKey = opts.sessionKey || activeSessionKey;
  const index = loadIndex(sessionKey);
  if (!index.length) {
    return {
      ok: true,
      hits: [],
      indexSize: 0,
      note: "VCTX empty — nothing archived yet for this session",
    };
  }

  const maxItems = Math.min(12, Math.max(1, opts.maxItems ?? 4));
  const maxChars = Math.min(12000, Math.max(400, opts.maxCharsPerItem ?? 3500));
  const hits: VctxRecallHit[] = [];

  if (opts.ids?.length) {
    for (const id of opts.ids.slice(0, maxItems)) {
      const meta = index.find((x) => x.id === id);
      if (!meta) continue;
      const content = readSlotFull(sessionKey, meta);
      const formatted = formatExcerpt(meta.id, meta.role, meta.tool_name, content, maxChars);
      hits.push({
        id: meta.id,
        role: meta.role,
        tool_name: meta.tool_name,
        score: 100,
        truncated: formatted.truncated,
        content: formatted.text,
      });
    }
  } else {
    const q = (opts.query || "").trim();
    if (!q) {
      return { ok: false, error: "query or ids required" };
    }
    const askTerms = terms(q);
    const scored = index
      .map((meta) => {
        const content = readSlotFull(sessionKey, meta);
        const score =
          scoreChunk(askTerms, `${meta.preview}\n${content}`, meta.role) +
          (content.toLowerCase().includes(q.toLowerCase()) ? 3 : 0);
        return { meta, content, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxItems);

    for (const s of scored) {
      const formatted = formatExcerpt(s.meta.id, s.meta.role, s.meta.tool_name, s.content, maxChars);
      hits.push({
        id: s.meta.id,
        role: s.meta.role,
        tool_name: s.meta.tool_name,
        score: s.score,
        truncated: formatted.truncated,
        content: formatted.text,
      });
    }
  }

  return {
    ok: true,
    hits,
    indexSize: index.length,
    note: `returned ${hits.length} discrete slots (not merged); index=${index.length}`,
  };
}

/** List recent slot index for the model (titles only). */
export function vctxListIndex(limit = 40, sessionKey?: string): string {
  const index = loadIndex(sessionKey);
  const slice = index.slice(-Math.max(5, limit));
  if (!slice.length) return "(VCTX index empty)";
  return slice
    .map(
      (m) =>
        `- id=${m.id} turn=${m.turn} role=${m.role}${m.tool_name ? "/" + m.tool_name : ""} chars=${m.chars} :: ${m.preview}`
    )
    .join("\n");
}

/**
 * Pack history: keep recent FULL; archive older as slots; inject small separated excerpts + index.
 */
export function packChunkedContext(
  history: ChatMessage[],
  opts: ChunkPackOptions
): ChunkPackResult {
  if (opts.sessionKey) setVctxSessionKey(opts.sessionKey);

  const windowTokens = Math.max(1024, opts.windowTokens);
  const virtualTarget = opts.virtualTargetTokens ?? 32768;
  const rawTokens =
    tok(opts.systemPrompt) + tok(opts.userText) + history.reduce((a, m) => a + msgTok(m), 0);

  const historyBudget = Math.floor(windowTokens * 0.72);
  const recentBudget = Math.floor(historyBudget * 0.62);
  const memoryBudget = historyBudget - recentBudget;

  const systems = history.filter(
    (m) => m.role === "system" && !String(m.content || "").startsWith("[VCTX")
  );
  const cleanRest = history.filter((m) => m.role !== "system");

  const recent: ChatMessage[] = [];
  let recentTok = 0;
  for (let i = cleanRest.length - 1; i >= 0; i--) {
    const t = msgTok(cleanRest[i]);
    if (recentTok + t > recentBudget && recent.length > 0) break;
    recent.unshift(cleanRest[i]);
    recentTok += t;
  }
  const older = cleanRest.slice(0, Math.max(0, cleanRest.length - recent.length));

  if (!older.length && rawTokens <= windowTokens) {
    return {
      messages: history.filter((m) => !String(m.content || "").startsWith("[VCTX")),
      usedTokens: rawTokens,
      rawTokens,
      virtualTokens: Math.min(virtualTarget, rawTokens),
      packed: false,
      note: "full history fits window",
      hitRate: 1,
    };
  }

  const askTerms = terms(opts.userText);
  const sessionKey = opts.sessionKey || activeSessionKey;
  let slotsWritten = 0;
  const seen = new Set<string>();

  if (opts.persistSlots !== false && older.length && sessionKey) {
    // Skip content already on disk (avoid re-archive every turn)
    for (const row of loadIndex(sessionKey)) {
      seen.add(`${row.role}|${row.tool_name || ""}|${row.preview}|${row.chars}`);
    }
    for (let i = 0; i < older.length; i++) {
      const m = older[i];
      const body = (m.content || "").trim();
      const dedupe = `${m.role}|${m.tool_name || ""}|${previewOf(body, 140)}|${body.length}`;
      if (seen.has(dedupe)) continue;
      const meta = persistSlot(sessionKey, m, i, seen);
      if (meta) {
        seen.add(dedupe);
        slotsWritten++;
      }
    }
  }

  // Index lines (titles only — no content smash)
  const digestLines = older.map((m, i) => titleOf(m, i));
  let digest = digestLines.join("\n");
  const digestCap = Math.floor(memoryBudget * 0.28);
  while (tok(digest) > digestCap && digestLines.length > 4) {
    digestLines.splice(0, Math.ceil(digestLines.length * 0.15));
    digest = digestLines.join("\n");
  }

  // Retrieve a few FULL-or-fenced excerpts (separated)
  const ranked = older
    .map((m, idx) => ({
      m,
      idx,
      score: scoreChunk(askTerms, `${m.content || ""} ${m.tool_name || ""}`, m.role),
    }))
    .sort((a, b) => b.score - a.score);

  const roleCap: Record<string, number> = { user: 3, assistant: 4, tool: 5 };
  const roleCounts: Record<string, number> = {};
  const excerpts: string[] = [];
  let memTok = 0;
  const retrieveBudget = Math.floor(memoryBudget * 0.55);
  const perItemChars = 900;

  for (const r of ranked) {
    const role = r.m.role || "assistant";
    if ((roleCounts[role] || 0) >= (roleCap[role] ?? 3)) continue;
    if (r.score <= 0 && excerpts.length >= 2) continue;
    const id = `mem_${r.idx}`;
    const formatted = formatExcerpt(id, role, r.m.tool_name, r.m.content || "", perItemChars);
    const t = tok(formatted.text);
    if (memTok + t > retrieveBudget) continue;
    excerpts.push(formatted.text);
    roleCounts[role] = (roleCounts[role] || 0) + 1;
    memTok += t;
    if (excerpts.length >= 8) break;
  }

  // Also pull a couple disk hits (already archived)
  const disk = vctxRecall({
    query: opts.userText,
    maxItems: 3,
    maxCharsPerItem: 700,
    sessionKey,
  });
  if (disk.ok) {
    for (const h of disk.hits) {
      const t = tok(h.content);
      if (memTok + t > retrieveBudget) break;
      // skip if looks like duplicate of an in-memory excerpt
      if (excerpts.some((e) => e.includes(h.content.slice(0, 80)))) continue;
      excerpts.push(h.content);
      memTok += t;
    }
  }

  const packTerms = terms(digest + "\n" + excerpts.join("\n"));
  let covered = 0;
  for (const w of askTerms) if (packTerms.has(w)) covered++;
  const hitRate = askTerms.size ? covered / askTerms.size : 0;

  // VCTX must NOT be a second system message — Qwen Jinja: system only at index 0.
  const vctxText =
    `[VCTX · window=${windowTokens}]\n` +
    `Недавние сообщения полные; старые — кратко в индексе.\n` +
    (digest ? `--- INDEX ---\n${digest}\n` : "") +
    (excerpts.length ? `--- RETRIEVED ---\n${excerpts.join("\n\n")}\n` : "") +
    `--- END VCTX ---`;
  const sysMerged: ChatMessage = {
    role: "system",
    content: [...systems.map((s) => String(s.content || "").trim()), vctxText]
      .filter(Boolean)
      .join("\n\n"),
  };

  // Pin live user task — Qwen templates 500 if pack left only system+tool turns.
  const task = String(opts.userText || "").trim();
  const pinnedUser: ChatMessage | undefined = task
    ? { role: "user", content: task.length > 4000 ? task.slice(0, 4000) + "…" : task }
    : undefined;
  const recentClean = (pinnedUser
    ? recent.filter(
        (m) => !(m.role === "user" && String(m.content || "").trim() === String(pinnedUser.content).trim())
      )
    : recent
  ).filter((m) => m.role !== "system");
  shrinkHeavyMessages(recentClean, 2800);

  const out: ChatMessage[] = pinnedUser
    ? [sysMerged, pinnedUser, ...recentClean]
    : [sysMerged, ...recentClean];
  ensurePlainUserQuery(out, opts.userText);
  normalizeMessagesForQwen(out);
  const usedTokens =
    tok(opts.systemPrompt) + tok(opts.userText) + out.reduce((a, m) => a + msgTok(m), 0);

  const indexSize = loadIndex(sessionKey).length;
  const virtualTokens = Math.min(
    virtualTarget,
    Math.max(rawTokens, usedTokens, indexSize * 64)
  );

  return {
    messages: out,
    usedTokens,
    rawTokens,
    virtualTokens,
    packed: true,
    hitRate,
    note:
      `vctx older=${older.length} archived=${slotsWritten} excerpts=${excerpts.length}` +
      ` recent=${recent.length} hit=${hitRate.toFixed(2)} index=${indexSize}`,
  };
}
