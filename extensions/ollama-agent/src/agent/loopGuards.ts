/** Pure guards for the agent tool loop (unit-testable, no vscode). */

export function isSimpleWriteAsk(text: string): boolean {
  return /создай|create|touch|пустой\s+файл|empty\s+file|напиши\s+(тут\s+)?файл|write\s+(a\s+)?file|наполни/i.test(
    text || ""
  );
}

export function isActionRequest(text: string): boolean {
  return /создай|создать|напиши|наполни|исправ|почин|удал|перестав|запусти|установи|добав|измен|отредактир|реализуй|сделай|write|create|fix|delete|run|install|edit|update|refactor|implement|touch/i.test(
    text || ""
  );
}

export function isPlanOnly(text: string, thinking: string): boolean {
  const blob = `${text || ""}\n${thinking || ""}`.trim();
  if (!blob) return false;
  if (/файл\s+создан|готово\.|done\.|создал\s+|wrote\s+|created\s+/i.test(blob) && blob.length < 400) {
    return false;
  }
  return (
    /план|шаг\s*\d|сделаю|создам|напишу|исправлю|затем|потом|will\s+(create|write|fix)|i('ll| will)\s+/i.test(
      blob
    ) ||
    (/^\s*[-*]|\d+\.\s+/m.test(blob) && /файл|file|write|созда|edit|запуст/i.test(blob))
  );
}

/** Model stopped before a usable final answer or tool_calls */
export function looksIncompleteUtterance(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return true;
  if (/[,:;…]\s*$/.test(t)) return true;
  if (/[—–\-]\s*$/.test(t)) return true; // cut after dash
  if (/(исправляю|починю|fixing|updating|создам|напишу|сейчас\s+сделаю)\s*:?\s*$/i.test(t)) {
    return true;
  }
  if (/(чтобы|сейчас|затем|потом|далее|и\s+тогда|посмотрю|нужно)\s*$/i.test(t)) return true;
  if (t.length < 80 && /файл\s+открыт|содержим|посмотр/i.test(t)) return true;
  // Unmatched quotes / brackets — classic mid-sentence cut («…инициализирует себя "»)
  if (hasUnbalancedDelimiters(t)) return true;
  // Ends mid-clause: letter/digit then open quote, or no sentence ender on a short wrap-up
  if (/[\p{L}\p{N}]\s*["'`«]\s*$/u.test(t)) return true;
  if (
    t.length < 280 &&
    /^(отлично|хорошо|супер|файл\s+обнов|готово|теперь|бот)\b/i.test(t) &&
    !/[.!?…»")\]]\s*$/u.test(t) &&
    /[—–,]/.test(t)
  ) {
    return true;
  }
  // Mid-task chatter without tools («Ага! Нужно…», «Давай подправим…»)
  if (looksLikeContinuingWork(t)) return true;
  return false;
}

function hasUnbalancedDelimiters(t: string): boolean {
  const dq = (t.match(/"/g) || []).length;
  if (dq % 2 === 1) return true;
  const guillemetOpen = (t.match(/«/g) || []).length;
  const guillemetClose = (t.match(/»/g) || []).length;
  if (guillemetOpen !== guillemetClose) return true;
  let paren = 0;
  let bracket = 0;
  for (const ch of t) {
    if (ch === "(") paren++;
    else if (ch === ")") paren--;
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket--;
    if (paren < 0 || bracket < 0) return true;
  }
  return paren !== 0 || bracket !== 0;
}

/** Detect copy-pasted identical clauses inside one utterance */
export function hasStutteringRepetition(text: string): boolean {
  return detectGenerationLoop(text).looping;
}

export type GenerationLoopHit = {
  looping: boolean;
  /** Short fragment that kept repeating (for nudges / logs) */
  fragment?: string;
};

/**
 * Soft, model-agnostic detection of generation collapse.
 * Conservative: normal answers often repeat a short clause twice —
 * that must NOT trigger regenerate (false positives caused agent thrash).
 */
export function detectGenerationLoop(text: string): GenerationLoopHit {
  const t = String(text || "")
    .replace(/\s+/g, " ")
    .trim();

  // 0) Glyph / character collapse — check even on short dumps
  const run = t.match(/(.)\1{19,}/u);
  if (run) return { looping: true, fragment: run[0].slice(0, 40) };
  if (t.length < 72) return { looping: false };
  if (t.length >= 200) {
    const letters = (t.match(/\p{L}/gu) || []).length;
    if (letters / t.length < 0.28) {
      return { looping: true, fragment: t.slice(0, 80) };
    }
  }

  // 1) Identical sentences — need ≥3 copies (or ≥2 if very long + majority of text)
  const sentences = t
    .split(/(?<=[.!?…])\s+|;\s+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 28);
  if (sentences.length >= 3) {
    const counts = new Map<string, number>();
    for (const s of sentences) {
      const n = (counts.get(s) || 0) + 1;
      counts.set(s, n);
      if (n >= 3) return { looping: true, fragment: s.slice(0, 120) };
      if (n >= 2 && s.length >= 80 && sentences.length <= 4) {
        return { looping: true, fragment: s.slice(0, 120) };
      }
    }
  }

  // 2) Leading chunk appears again — require three copies, or two of a long chunk
  for (let n = 50; n <= 120; n += 10) {
    if (t.length < n * 3) break;
    const chunk = t.slice(0, n);
    const second = t.indexOf(chunk, n);
    if (second === -1) continue;
    const third = t.indexOf(chunk, second + n);
    if (third !== -1 || (n >= 90 && t.length >= n * 2.5)) {
      return { looping: true, fragment: chunk.slice(0, 120) };
    }
  }

  // 3) Word n-gram spam (mashed text without sentence breaks)
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length >= 36) {
    const singles = words.filter((w) => w.length === 1).length;
    if (words.length >= 48 && singles / words.length > 0.45) {
      return { looping: true, fragment: words.slice(0, 16).join(" ") };
    }
    for (const win of [8, 10, 12]) {
      if (words.length < win * 4) continue;
      const counts = new Map<string, number>();
      let best = "";
      let bestN = 0;
      for (let i = 0; i <= words.length - win; i++) {
        const g = words.slice(i, i + win).join(" ");
        const n = (counts.get(g) || 0) + 1;
        counts.set(g, n);
        if (n > bestN) {
          bestN = n;
          best = g;
        }
      }
      // Same 8–12 words ≥4 times ⇒ real collapse
      if (bestN >= 4) return { looping: true, fragment: best.slice(0, 140) };
    }

    if (words.length >= 100) {
      const bigrams = new Set<string>();
      for (let i = 0; i < words.length - 1; i++) {
        bigrams.add(`${words[i]} ${words[i + 1]}`);
      }
      const ratio = bigrams.size / (words.length - 1);
      if (ratio < 0.28) {
        return { looping: true, fragment: words.slice(0, 12).join(" ") };
      }
    }
  }

  return { looping: false };
}

/** Language-agnostic char-bigram Jaccard (0..1). */
export function textSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = grams(x);
  const B = grams(y);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Exact tape-loop at the tail: …UU where |U|≥minUnit (pi-repetition-guard style). */
export function findTailPeriodUnit(text: string, minUnit = 48): string | undefined {
  const t = String(text || "");
  const maxP = Math.min(220, Math.floor(t.length / 2));
  for (let p = maxP; p >= minUnit; p--) {
    const unit = t.slice(-p);
    if (t.slice(-2 * p, -p) === unit) return unit;
  }
  return undefined;
}

function splitThinkingUnits(text: string): string[] {
  return String(text || "")
    .split(/\n{2,}|(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 48);
}

/**
 * Soft thinking guard (sly.so / pi-repetition-guard spectrum):
 * - near-similar units → soft_skip (hide from UI, keep stream for tools/content)
 * - exact tail tape-loop → soft_skip; escalate only after sustained mute
 * - new / dissimilar units always pass (2nd reasoning round, post-tool reflection OK)
 * - no language hardcodes
 */
export type SoftThinkVerdict = {
  /** Delta safe to show in the thinking UI (may be empty while stream continues). */
  emitDelta: string;
  /** Sustained verbatim runaway — caller may stop reading after tools/content chance. */
  escalate: boolean;
  reason?: string;
};

export class SoftThinkingGuard {
  private emitted = "";
  /** Useful (non-reopen) thinking already shown — separate from full stream cursor. */
  private emittedUseful = "";
  private mutedChars = 0;
  private anchorStem = "";
  /** Stem of the user ask — catches RU↔EN paraphrases of the same task. */
  private userStem = "";
  private taskKeys: string[] = [];
  /** Once a restate is detected, keep soft-muting until reset (tools/content). */
  private softMuted = false;
  /** After tools — suppress restates of the first-round stem; keep TOOL_RESULT thinking. */
  private postTool = false;
  private readonly simThreshold: number;
  private readonly stemThreshold: number;
  private readonly escalateAfter: number;

  constructor(opts?: {
    simThreshold?: number;
    stemThreshold?: number;
    escalateAfter?: number;
  }) {
    this.simThreshold = opts?.simThreshold ?? 0.74;
    this.stemThreshold = opts?.stemThreshold ?? 0.62;
    this.escalateAfter = opts?.escalateAfter ?? 1600;
  }

  /** Pin user ask once per turn (cross-language reopen mute). */
  setUserTask(userText: string): void {
    const t = String(userText || "").replace(/\[ATTACHMENTS\][\s\S]*$/i, " ");
    this.userStem = this.stemOf(t).slice(0, 120);
    const keys = new Set<string>();
    for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9_.\\/-]{2,}|[А-Яа-яЁё]{4,}/g)) {
      const k = m[0].toLowerCase();
      if (k.length >= 3) keys.add(k);
    }
    this.taskKeys = [...keys].slice(0, 48);
  }

  /** Full reset (new user turn). */
  reset(): void {
    this.emitted = "";
    this.emittedUseful = "";
    this.mutedChars = 0;
    this.anchorStem = "";
    this.softMuted = false;
    this.postTool = false;
    // keep userStem / taskKeys for the whole turn
  }

  /**
   * Visible assistant text arrived — clear mute tape, KEEP task anchor
   * (full reset() used to wipe anchor and let «The user wants…» reopen).
   */
  noteVisibleProgress(): void {
    this.emitted = "";
    this.emittedUseful = "";
    this.mutedChars = 0;
    this.softMuted = false;
  }

  /**
   * After TOOL_RESULT — allow reflection on new evidence, but KEEP the first-round
   * anchor so near-duplicate task restates stay muted (language-agnostic).
   */
  allowPostToolReflection(): void {
    this.emitted = "";
    this.emittedUseful = "";
    this.mutedChars = 0;
    this.softMuted = false;
    this.postTool = true;
  }

  private stemOf(unit: string): string {
    return unit.replace(/\s+/g, " ").trim().slice(0, 96);
  }

  private looksLikeEvidence(unit: string): boolean {
    return /\b(TOOL_RESULT|FAILED|BLOCKED|error:|OK\b|entries|traceback|exit:|list_files|read_file|grep)\b/i.test(
      unit || ""
    ) || /<tool_call>|<function=/i.test(unit || "");
  }

  /** True when unit restates the first-round stem or the user ask (any language). */
  private isAnchorRestate(unit: string): boolean {
    if (!unit) return false;
    const stem = this.stemOf(unit);
    if (stem.length < 28) return false;
    if (this.anchorStem && textSimilarity(this.anchorStem, stem) >= this.stemThreshold) {
      return true;
    }
    if (this.userStem && textSimilarity(this.userStem, stem) >= this.stemThreshold) {
      return true;
    }
    // Cross-language: shared task tokens (esp. Latin product/paths) + no evidence → reopen
    if (this.postTool && this.taskKeys.length && !this.looksLikeEvidence(unit)) {
      const u = unit.toLowerCase();
      let hits = 0;
      let latinHits = 0;
      for (const k of this.taskKeys) {
        if (!u.includes(k)) continue;
        hits++;
        if (/[a-z]/i.test(k) && k.length >= 4) latinHits++;
      }
      const need = Math.min(4, Math.max(2, Math.ceil(this.taskKeys.length * 0.12)));
      if (hits >= need && stem.length >= 36) return true;
      // RU ask → EN thinking often shares only product names (Cursor, Ollama, …)
      if (latinHits >= 1 && stem.length >= 40) return true;
    }
    return false;
  }

  /**
   * Drop leading paragraphs that restate the turn anchor; keep evidence / next-action.
   * Returns char index where useful thinking starts (text.length if all reopen).
   */
  private usefulThinkingStart(text: string): number {
    const t = String(text || "");
    if (!t.trim() || !this.anchorStem || !(this.postTool || this.anchorStem)) return 0;
    if (!this.isAnchorRestate(t.trim().slice(0, 200)) && !/\n{2,}/.test(t)) {
      // Short stream still building — if whole short blob is anchor-like, mute
      if (t.length < 220 && this.isAnchorRestate(t)) return t.length;
      return 0;
    }
    const paras = t.split(/\n{2,}/);
    if (paras.length >= 2) {
      let cut = 0;
      for (let i = 0; i < paras.length; i++) {
        const p = paras[i] || "";
        if (!this.isAnchorRestate(p) || this.looksLikeEvidence(p)) {
          return cut;
        }
        cut += p.length;
        if (i < paras.length - 1) {
          const rest = t.slice(cut);
          const sep = rest.match(/^\n{2,}/);
          cut += sep ? sep[0].length : 0;
        }
      }
      return t.length;
    }
    if (this.isAnchorRestate(t) && !this.looksLikeEvidence(t)) return t.length;
    return 0;
  }

  private isRestateOfEarlier(text: string): string | undefined {
    const tape = findTailPeriodUnit(text, 48);
    if (tape) return "tail_period";

    const units = splitThinkingUnits(text);
    if (!units.length) return undefined;
    const last = units[units.length - 1] || "";
    const first = units[0] || "";
    // Post-tool: first unit ≈ first-round stem → hide (no phrase hardcode)
    if ((this.postTool || this.anchorStem) && this.isAnchorRestate(first)) {
      return "stem_reopen";
    }
    if (units.length < 2) return undefined;
    const checkable = /[.!?…»")\]]\s*$/u.test(last) || last.length >= 72;
    if (!checkable) return undefined;

    const lastStem = this.stemOf(last);
    if (!this.anchorStem && units[0]) this.anchorStem = this.stemOf(units[0]);

    if (
      this.anchorStem &&
      lastStem.length >= 36 &&
      textSimilarity(this.anchorStem, lastStem) >= this.stemThreshold
    ) {
      return "stem_reopen";
    }

    for (let i = 0; i < units.length - 1; i++) {
      const prev = units[i] || "";
      if (last.length >= 110 && textSimilarity(prev, last) >= this.simThreshold) {
        return "unit_similarity";
      }
      if (
        textSimilarity(this.stemOf(prev), lastStem) >= this.stemThreshold &&
        lastStem.length >= 36
      ) {
        return "stem_similarity";
      }
    }
    return undefined;
  }

  /**
   * Feed full thinking so far. Returns what to append to the UI.
   * Soft-filters UI duplicates; keeps stream alive for tools / later distinct reflection.
   */
  filter(full: string): SoftThinkVerdict {
    const text = String(full || "");
    if (!text) return { emitDelta: "", escalate: false };

    if (this.emitted && !text.startsWith(this.emitted) && text.length < this.emitted.length) {
      this.reset();
    }

    const delta = text.startsWith(this.emitted) ? text.slice(this.emitted.length) : text;
    if (!delta) return { emitDelta: "", escalate: false };

    // Post-tool / after anchor: strip leading stem-restates; keep evidence / next-action tail
    if (this.postTool || this.anchorStem) {
      const usefulAt = this.usefulThinkingStart(text);
      if (usefulAt > 0) {
        const useful = text.slice(usefulAt);
        if (!useful.trim()) {
          this.emitted = text;
          return {
            emitDelta: "",
            escalate: false,
            reason: usefulAt >= text.length && text.length < 220 ? "stem_prefix" : "stem_reopen",
          };
        }
        const usefulDelta = useful.startsWith(this.emittedUseful)
          ? useful.slice(this.emittedUseful.length)
          : useful;
        this.emittedUseful = useful;
        this.emitted = text;
        this.mutedChars = 0;
        return {
          emitDelta: usefulDelta,
          escalate: false,
          reason: usefulDelta ? undefined : "stem_reopen",
        };
      }
    }

    if (this.softMuted) {
      this.mutedChars += delta.length;
      this.emitted = text;
      return {
        emitDelta: "",
        escalate: this.mutedChars >= this.escalateAfter,
        reason: "soft_muted",
      };
    }

    const why = this.isRestateOfEarlier(text);
    if (why) {
      if (why === "stem_reopen") {
        this.emitted = text;
        return { emitDelta: "", escalate: false, reason: why };
      }
      this.softMuted = true;
      this.mutedChars += delta.length;
      this.emitted = text;
      return {
        emitDelta: "",
        escalate: this.mutedChars >= this.escalateAfter,
        reason: why,
      };
    }

    this.mutedChars = 0;
    if (!this.anchorStem) {
      const u0 = splitThinkingUnits(text)[0];
      if (u0 && u0.length >= 40) this.anchorStem = this.stemOf(u0);
    }
    this.emitted = text;
    this.emittedUseful = text;
    return { emitDelta: delta, escalate: false };
  }
}

/** @deprecated use SoftThinkingGuard — kept for tests / call sites */
export function detectThinkingRestate(thinking: string): GenerationLoopHit {
  const g = new SoftThinkingGuard({ escalateAfter: 400 });
  // Simulate progressive feed by paragraphs
  let acc = "";
  let hit = false;
  let fragment = "";
  for (const part of String(thinking || "").split(/(?<=[.!?…])\s+/)) {
    acc = acc ? `${acc} ${part}` : part;
    const v = g.filter(acc);
    if (v.reason && !v.emitDelta) {
      hit = true;
      fragment = v.reason;
    }
  }
  // Also direct full-text check
  const tape = findTailPeriodUnit(thinking, 48);
  if (tape) return { looping: true, fragment: tape.slice(0, 80) };
  const units = splitThinkingUnits(thinking);
  if (units.length >= 2) {
    const last = units[units.length - 1] || "";
    const lastStem = last.replace(/\s+/g, " ").trim().slice(0, 96);
    for (let i = 0; i < units.length - 1; i++) {
      const prev = units[i] || "";
      if (textSimilarity(prev, last) >= 0.74) {
        return { looping: true, fragment: last.slice(0, 80) };
      }
      const prevStem = prev.replace(/\s+/g, " ").trim().slice(0, 96);
      if (lastStem.length >= 40 && textSimilarity(prevStem, lastStem) >= 0.7) {
        return { looping: true, fragment: lastStem.slice(0, 80) };
      }
    }
  }
  if (hit) return { looping: true, fragment };
  if (String(thinking || "").length >= 4000) return { looping: true, fragment: "thinking_cap" };
  return { looping: false };
}

/** Soft nudge when generation looped — steers ANY model back to evidence. */
export const GENERATION_LOOP_NUDGE = [
  "[system] Generation looped / петля генерации: одна идея без нового факта из tool.",
  "Reset: (1) tool (read_file / run_in_terminal / get_terminal_output) или уже есть TOOL_RESULT;",
  "(2) назови конкретный сбой из evidence;",
  "(3) правь только то, что подтверждает evidence.",
  "Сейчас: tool_calls. Рассуждай столько, сколько нужно — без повторов одной фразы. Язык = язык пользователя.",
].join(" ");

/** After tools the model narrated the next step but issued no tool_calls. */
export function continueWorkNudge(userText: string): string {
  const cyr = ((userText || "").match(/[А-Яа-яЁё]/g) || []).length;
  if (cyr >= 3) {
    return (
      "[system] Ты описал следующий шаг текстом, но tool_calls нет. " +
      "Сразу вызови нужный tool по последнему TOOL_RESULT. " +
      "Не пересказывай задачу и не переключайся на английский. Язык ответа = язык пользователя."
    );
  }
  return (
    "[system] You described the next step in prose but issued no tool_calls. " +
    "Call the tool now from the latest TOOL_RESULT. Do not restate the user task."
  );
}

/** Narrating the next fix instead of finishing or calling tools */
export function looksLikeContinuingWork(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  const loop = detectGenerationLoop(t);
  if (loop.looping) return true;
  // Long mid-work essays still count — accepting them as "done" is what kills the turn
  if (t.length > 2400) return false;
  if (/\?\s*$/.test(t)) return false;
  if (
    /^(готово|сделано|done|успешно)\b/i.test(t) &&
    !/\b(should|нужно|надо|let'?s|let me|сейчас|need to|continue)\b/i.test(t)
  ) {
    return false;
  }
  if (
    /\b(готово[.!]|done[.!]|успешно\s+заверш|всё\s+работает)\b/i.test(t) &&
    !/\b(i should|let'?s|let me|нужно|надо|run (the )?bot again|continue reading)\b/i.test(t)
  ) {
    return false;
  }
  return (
    /^(ага|о+|ок|так|now that|well|okay|alright|давай)[!.,\s]/i.test(t) ||
    /\b(нужно|надо|давай|сейчас\s+(поправ|исправ|создам|прочитаю|запущу|начн)|подправим|увелич|исправлю|просто\s+использу|начну\s+с|читаю|греп|заблокир)\b/i.test(
      t
    ) ||
    /\b(i should|i'?ll|let'?s|let me|need to|going to|will)\s+(run|start|launch|fix|check|test|try|call|execute|continue|read|see|switch|use|search|look)\b/i.test(
      t
    ) ||
    /\b(continue|keep)\s+reading\b/i.test(t) ||
    /\bi need to (continue|see|read|verify|understand|fix|switch|try)\b/i.test(t) ||
    /\b(run|start|launch)\s+(the\s+)?(bot|server|app|script)\s+again\b/i.test(t) ||
    /\bnow that\b.+\b(i should|let'?s|run)\b/i.test(t) ||
    (/\b(файл\s+(исправлен|обновлён|fixed)|file is (now )?fixed|await main\(\))\b/i.test(t) &&
      /\b(run|запуст|should|let'?s)\b/i.test(t)) ||
    /\b(терминал\s+заблок|terminal\s+(is\s+)?block|BLOCKED|повтор\s+уже\s+выполн|слегка\s+измен(им|ить)\s+команд|change\s+the\s+command\s+slightly)\b/i.test(
      t
    ) ||
    /\b(get_terminal_output|kill_terminal).{0,40}(продолж|continue|монитор)/i.test(t) ||
    /\b(instead of|вместо того|напрямую|directly)\b/i.test(t)
  );
}

/**
 * No tool_calls this round — regenerate instead of accepting as final.
 * After tools: only regenerate on clear collapse / incomplete cut —
 * never thrash on a normal short summary (that felt like "step spam").
 */
export function shouldRegenerateWithoutTools(
  userText: string,
  assistantText: string,
  thinking: string,
  toolsExecuted: number
): boolean {
  const text = String(assistantText || "").trim();
  const think = String(thinking || "").trim();

  // Collapse only on visible assistant text — NOT on thinking (Qwen restates the ask there).
  if (text && detectGenerationLoop(text).looping) return true;

  // Incomplete surface text (cut mid-sentence / mid-action)
  if (text) {
    if (/[,:;…]\s*$/.test(text)) return true;
    if (/[—–\-]\s*$/.test(text)) return true;
    if (hasUnbalancedDelimiters(text)) return true;
    if (/[\p{L}\p{N}]\s*["'`«]\s*$/u.test(text)) return true;
    if (/(исправляю|починю|fixing|updating|создам|напишу|сейчас\s+сделаю)\s*:?\s*$/i.test(text)) {
      return true;
    }
    if (/(чтобы|сейчас|затем|потом|далее|и\s+тогда|посмотрю|нужно)\s*$/i.test(text)) {
      return true;
    }
    // Short mid-action stump («Исправляю ошибку в») — not a finished answer
    // Note: JS \b is ASCII-only; use space/end lookahead for Cyrillic verbs
    if (
      text.length < 80 &&
      /^(исправляю|починю|создам|напишу|сейчас|fixing|updating)(?=\s|$|[:.])/i.test(text) &&
      !/[.!?…»"]\s*$/u.test(text)
    ) {
      return true;
    }
  }

  // After tools: mid-work narration without tool_calls → continue (do NOT accept as done)
  if (toolsExecuted > 0) {
    if (!text && think && looksLikeContinuingWork(think)) return true;
    if (text && looksLikeContinuingWork(text)) return true;
    if (text && looksIncompleteUtterance(text)) return true;
    return false;
  }

  if (!text && !think) {
    return isActionRequest(userText) || isSimpleWriteAsk(userText);
  }
  if (
    !text &&
    think &&
    (isActionRequest(userText) || isSimpleWriteAsk(userText)) &&
    (looksLikeContinuingWork(think) || isPlanOnly(text, think))
  ) {
    return true;
  }
  // Plan-only before first tool: regenerate so the model actually calls tools
  if (isPlanOnly(text, think) && (isActionRequest(userText) || isSimpleWriteAsk(userText))) {
    return true;
  }
  // Mid-work chatter before any tool on an action ask
  if (
    text &&
    looksLikeContinuingWork(text) &&
    (isActionRequest(userText) || isSimpleWriteAsk(userText))
  ) {
    return true;
  }
  return false;
}

/** @deprecated use shouldRegenerateWithoutTools */
export function shouldContinueForAction(
  userText: string,
  assistantText: string,
  thinking: string,
  toolsExecuted: number
): boolean {
  return shouldRegenerateWithoutTools(userText, assistantText, thinking, toolsExecuted);
}

/** Tools that distract simple «создай файл тут» asks into exploration loops */
export const SIMPLE_WRITE_BLOCKED_TOOLS =
  /^(repo_map|list_files|search_files|grep|run_subagent|vctx_index|vctx_recall|open_workspace|create_project_workspace|move_chat_workspace|manage_todo_list|update_task|read_file)$/i;

export function filterToolsForUserAsk<T extends { function?: { name?: string }; name?: string }>(
  defs: T[],
  userText: string
): T[] {
  if (!isSimpleWriteAsk(userText)) return defs;
  return defs.filter((d) => {
    const n = d?.function?.name || d?.name || "";
    return !SIMPLE_WRITE_BLOCKED_TOOLS.test(n);
  });
}

/** Soft-normalize args so tiny path truncations don't bypass repeat detection. */
export function normalizeArgsForFingerprint(name: string, args: unknown): unknown {
  if (!args || typeof args !== "object") return args ?? {};
  const o = { ...(args as Record<string, unknown>) };
  if (TERMINAL_LAUNCH_TOOLS.test(name) || /^(run_in_terminal|execute_command|runCommands)$/i.test(name)) {
    const cmd = String(o.command ?? o.cmd ?? "").replace(/\s+/g, " ").trim();
    // Fingerprint by normalized command only (ignore explanation / cwd noise)
    const soft = cmd.length > 96 ? cmd.slice(0, 96).toLowerCase() : cmd.toLowerCase();
    return { command: soft };
  }
  if (/^(list_files|repo_map)$/i.test(name)) {
    const path = String(o.path ?? o.folder ?? o.directory ?? o.dir ?? ".")
      .replace(/\\/g, "/")
      .replace(/\/+$/g, "")
      .toLowerCase() || ".";
    return { path };
  }
  if (/^read_file$/i.test(name)) {
    // Include offset/limit so paging a large file is not the same call as a full read.
    // Identical path+window after OK is still blocked (Cursor-style).
    const path = String(o.path ?? o.file ?? "").replace(/\\/g, "/").toLowerCase();
    const offset = o.offset != null && o.offset !== "" ? Number(o.offset) || 0 : 0;
    const limit = o.limit != null && o.limit !== "" ? Number(o.limit) || 0 : 0;
    return { path, offset, limit };
  }
  return o;
}

export function toolFingerprint(name: string, args: unknown): string {
  const norm = normalizeArgsForFingerprint(name, args);
  let a = "";
  try {
    a = JSON.stringify(norm ?? {});
  } catch {
    a = String(norm);
  }
  return `${name}\0${a}`;
}

/**
 * Same launch tool with a command that shares a long prefix (truncated path spam).
 * Catches: "C:\\Program Files (x" vs full Steam path as separate fingerprints.
 */
export function isSimilarTerminalLaunch(
  seen: Map<string, "OK" | "FAILED" | "OTHER">,
  name: string,
  args: unknown
): boolean {
  if (!TERMINAL_LAUNCH_TOOLS.test(name)) return false;
  const cmd = String((args as any)?.command ?? (args as any)?.cmd ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (cmd.length < 12) return false;
  const prefix = cmd.slice(0, Math.min(48, cmd.length));
  for (const key of seen.keys()) {
    const [prevName, prevArgsJson] = key.split("\0");
    if (!TERMINAL_LAUNCH_TOOLS.test(prevName || "")) continue;
    let prevCmd = "";
    try {
      prevCmd = String(JSON.parse(prevArgsJson || "{}").command || "");
    } catch {
      prevCmd = prevArgsJson || "";
    }
    if (!prevCmd) continue;
    if (prevCmd.startsWith(prefix) || prefix.startsWith(prevCmd.slice(0, 24))) {
      return true;
    }
  }
  return false;
}

/** User asked for a bot/GUI — console-only «готово» is not enough. */
export function needsDesktopE2eVerify(userText: string): boolean {
  const t = userText || "";
  return /(бот|telegram|телеграм|(^|[^\w])тг([^\w]|$)|discord|aiogram|tkinter|pyqt|wpf|winforms|gui|интерфейс|кнопк|desktop\s*app|\bbot\b)/i.test(
    t
  );
}

/**
 * Successful reads/polls may run again (edit→verify needs re-read of the SAME file).
 * Hard forever-block on OK read_file was wrong — it killed "check file after fix".
 * Spam is handled by {@link AgentLoopDetector} (N identical in a row), not by Map forever.
 * list_files / repo_map: same path OK once; different path is fine (path in fingerprint).
 */
const READ_OK_REPEATABLE =
  /^(read_file|search_files|grep|get_terminal_output|getTerminalOutput|send_to_terminal|sendToTerminal|vctx_recall|windows_desktop|run_subagent|await_subagent|list_subagents)$/i;

/** After one OK, same-name explore with empty/same path is a loop even if JSON differs slightly. */
const EXPLORE_ONCE_TOOLS = /^(list_files|repo_map)$/i;

export function normalizeExplorePath(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const o = args as Record<string, unknown>;
  const raw = String(o.path ?? o.folder ?? o.directory ?? o.dir ?? "").trim();
  return raw.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase() || ".";
}

export function isExploreLoop(
  seen: Map<string, "OK" | "FAILED" | "OTHER">,
  name: string,
  args: unknown
): boolean {
  if (!EXPLORE_ONCE_TOOLS.test(name)) return false;
  // Same tool + same path OK twice → loop. Different path (tools/ after root) is OK.
  const pathKey = normalizeExplorePath(args);
  const sep = String.fromCharCode(0);
  for (const [key, st] of seen) {
    if (st !== "OK") continue;
    const prevName = key.split(sep)[0] || "";
    const prevArgsRaw = key.split(sep)[1];
    if (!EXPLORE_ONCE_TOOLS.test(prevName) || prevName.toLowerCase() !== name.toLowerCase()) {
      continue;
    }
    let prevPath = ".";
    try {
      prevPath = normalizeExplorePath(prevArgsRaw ? JSON.parse(prevArgsRaw) : {});
    } catch {
      prevPath = ".";
    }
    if (prevPath === pathKey) return true;
  }
  return false;
}

/** Normalize path for same-file read spam detection. */
export function normalizeReadPath(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const o = args as Record<string, unknown>;
  return String(o.path ?? o.file ?? "")
    .replace(/\\/g, "/")
    .toLowerCase()
    .trim();
}

/**
 * @deprecated Prefer {@link AgentLoopDetector}. Kept for tests: true only after many
 * OK reads of the same path with no progress (default 6 — verify cycles need room).
 */
export function isSameFileReadSpam(
  seen: Map<string, "OK" | "FAILED" | "OTHER">,
  name: string,
  args: unknown,
  maxTimes = 6
): boolean {
  if (!/^read_file$/i.test(name)) return false;
  const path = normalizeReadPath(args);
  if (!path) return false;
  let n = 0;
  for (const [key, st] of seen) {
    if (st !== "OK") continue;
    const prevName = key.split("\0")[0] || "";
    if (!/^read_file$/i.test(prevName)) continue;
    try {
      const prev = JSON.parse(key.split("\0")[1] || "{}") as { path?: string };
      if ((prev.path || "") === path) n += 1;
    } catch {
      /* ignore */
    }
  }
  return n >= maxTimes;
}

/**
 * agent-loop-detector pattern (MIT / Princeu3): block only after N *consecutive*
 * identical tool+args — not "ever saw this fingerprint".
 * Progress (write/replace/kill) resets the streak so edit→re-read→verify works.
 */
export class AgentLoopDetector {
  private history: string[] = [];
  private readonly maxIdentical: number;
  private readonly window: number;

  constructor(opts?: { maxIdenticalCalls?: number; windowSize?: number }) {
    this.maxIdentical = Math.max(2, opts?.maxIdenticalCalls ?? 3);
    this.window = Math.max(8, opts?.windowSize ?? 24);
  }

  /** Record a call; return whether it should be blocked as a consecutive identical loop. */
  record(name: string, args: unknown): { blocked: boolean; reason: string; count: number } {
    const fp = toolFingerprint(name, args);
    this.history.push(fp);
    while (this.history.length > this.window) this.history.shift();
    let count = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i] !== fp) break;
      count += 1;
    }
    if (count >= this.maxIdentical) {
      return {
        blocked: true,
        count,
        reason:
          `Ты вызвал "${name}" с теми же args ${count} раз подряд (agent-loop-detector). ` +
          `Это петля. Смени подход: правь файл по ошибке из TOOL_RESULT, другой tool/args, или итоговый ответ. ` +
          `Повторный read_file после replace/write — нормален; крутить одно и то же без правки — нет.`,
      };
    }
    return { blocked: false, reason: "", count };
  }

  /** Peek without recording (for partitioning calls). */
  wouldBlock(name: string, args: unknown): boolean {
    const fp = toolFingerprint(name, args);
    let count = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i] !== fp) break;
      count += 1;
    }
    return count + 1 >= this.maxIdentical;
  }

  /** Mutating progress — consecutive identical streak resets (edit→verify). */
  noteProgress(): void {
    this.history = [];
  }

  reset(): void {
    this.history = [];
  }
}

/** After write/replace — allow re-read of that path (content changed). */
export function forgetReadFingerprintsForPath(
  seen: Map<string, "OK" | "FAILED" | "OTHER">,
  filePath: string
): number {
  const want = String(filePath || "")
    .replace(/\\/g, "/")
    .toLowerCase()
    .trim();
  if (!want) return 0;
  let n = 0;
  for (const key of [...seen.keys()]) {
    const name = key.split("\0")[0] || "";
    if (!/^read_file$/i.test(name)) continue;
    try {
      const prev = JSON.parse(key.split("\0")[1] || "{}") as { path?: string };
      if ((prev.path || "") === want) {
        seen.delete(key);
        n += 1;
      }
    } catch {
      /* ignore */
    }
  }
  return n;
}

/**
 * Sliding tool-call sequence for A↔B ping-pong (Cursor / agent-loop-detector style).
 * Push fingerprint each executed/blocked attempt; detect alternating pairs.
 */
export function detectPingPongLoop(recentFingerprints: string[], minCycles = 2): boolean {
  if (recentFingerprints.length < minCycles * 2 + 2) return false;
  const a = recentFingerprints[recentFingerprints.length - 1];
  const b = recentFingerprints[recentFingerprints.length - 2];
  if (!a || !b || a === b) return false;
  let cycles = 0;
  for (let i = recentFingerprints.length - 1; i >= 1; i -= 2) {
    if (recentFingerprints[i] === a && recentFingerprints[i - 1] === b) cycles += 1;
    else break;
  }
  return cycles >= minCycles;
}

export function pushCallSequence(seq: string[], name: string, args: unknown, max = 24): string {
  const fp = toolFingerprint(name, args);
  seq.push(fp);
  while (seq.length > max) seq.shift();
  return fp;
}

/** Launch tools — same command blocked until file edit / kill clears fingerprints. */
export const TERMINAL_LAUNCH_TOOLS =
  /^(run_in_terminal|execute_command|runCommands|run_command)$/i;

/** After code change or kill — allow the same bot start command again. */
export function forgetTerminalLaunchFingerprints(
  seen: Map<string, "OK" | "FAILED" | "OTHER">
): number {
  let n = 0;
  for (const key of [...seen.keys()]) {
    const name = key.split("\0")[0] || "";
    if (TERMINAL_LAUNCH_TOOLS.test(name)) {
      seen.delete(key);
      n += 1;
    }
  }
  return n;
}

/**
 * Map-based repeats (FAILED forever / explore-once / truncated terminal).
 * Successful read_file is NEVER blocked here — verify-after-edit must re-read.
 * Consecutive identical spam → {@link AgentLoopDetector} (default 3 in a row).
 */
export function isRepeatToolCall(
  seen: Map<string, "OK" | "FAILED" | "OTHER">,
  name: string,
  args: unknown
): boolean {
  const prev = seen.get(toolFingerprint(name, args));
  if (prev) {
    // Same tool + same args again. Soft reads may repeat; explore/list only if path differs
    // (different path = different fingerprint via normalizeArgs).
    if (prev === "OK" && READ_OK_REPEATABLE.test(name)) return false;
    if (prev === "OK" && EXPLORE_ONCE_TOOLS.test(name)) return true; // same path twice
    if (prev === "FAILED" || prev === "OTHER" || prev === "OK") return true;
  }
  // Do NOT call isExploreLoop here — it used to mute list_files on *any* second path.
  // Truncated / slightly varied terminal commands still count as repeats
  if (isSimilarTerminalLaunch(seen, name, args)) return true;
  return false;
}

/** Overview / «посмотри проект» — after a bit of explore, prefer a final answer. */
export function isProjectOverviewAsk(text: string): boolean {
  if (isToolAuditAsk(text)) return false;
  return /(посмотр|обзор|разбер|что\s+за\s+проект|look\s+at|explore|overview).{0,40}(проект|project|repo|код|workspace)/i.test(
    text || ""
  ) || /^(привет|hello|hi).{0,20}(посмотр|глянь|look)/i.test(text || "");
}

/** User wants a sweep of many tools (incl. empty / error cases) — don't stop after 3–5 OK. */
export function isToolAuditAsk(text: string): boolean {
  const t = text || "";
  return (
    /(проверь|проверить|тест|test|check|exercise).{0,40}(все\s+)?(инструмент|tools?\b)/i.test(t) ||
    /(инструмент|tools?).{0,40}(пуст|ошибк|error|empty|fail)/i.test(t) ||
    /все\s+инструмент/i.test(t)
  );
}

/**
 * Shell "command" whose first token is actually a known tool name
 * (model types tool_calls into the terminal). Match against live tool list — no hardcode.
 */
export function shellCommandMatchesToolName(
  command: string,
  toolNames: Iterable<string>
): string | undefined {
  const first = String(command || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .split(/\s+/)[0];
  if (!first || first.length < 3) return undefined;
  const norm = (s: string) => s.replace(/_/g, "").toLowerCase();
  const want = norm(first);
  for (const n of toolNames) {
    if (!n) continue;
    if (n.toLowerCase() === first.toLowerCase() || norm(n) === want) return n;
  }
  return undefined;
}

/** Tools that share one failure domain (disable together). */
export function toolDisableFamily(name: string): string[] {
  if (/^(run_in_terminal|execute_command|runCommands|run_command)$/i.test(name)) {
    return ["run_in_terminal", "execute_command", "runCommands", "run_command"];
  }
  return [name];
}

export function filterDefsExcluding(
  defs: unknown[],
  disabled: Set<string>
): unknown[] {
  if (!disabled.size) return defs;
  const lower = new Set([...disabled].map((x) => x.toLowerCase()));
  return defs.filter((d) => {
    const x = d as { function?: { name?: string }; name?: string };
    const n = x?.function?.name || x?.name || "";
    return n && !lower.has(n.toLowerCase());
  });
}

export function rememberToolCall(
  seen: Map<string, "OK" | "FAILED" | "OTHER">,
  name: string,
  args: unknown,
  ok: boolean
): void {
  seen.set(toolFingerprint(name, args), ok ? "OK" : "FAILED");
}
