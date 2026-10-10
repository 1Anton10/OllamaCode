/**
 * Extract reasoning / thinking spans from model text.
 *
 * Common formats:
 * - Qwen3 / Qwen3.5: <think>…</think> (often only </think> — prefix is thinking)
 * - DeepSeek-R1 style: same <think> tags
 * - Some UIs: <thinking>…</thinking>
 * - Legacy / wrappers: <details><summary>thinking</summary>…</details>
 * - Rare: <|redacted_reasoning|>…</|redacted_reasoning|>
 */

const OPEN_CLOSE: Array<{ open: RegExp; close: RegExp; name: string }> = [
  {
    name: "think",
    // Models sometimes glue role: «короткоassistant <think>»
    open: /(?:assistant\s*)?<think>\s*/i,
    close: /\s*<\/think>/i,
  },
  {
    name: "thinking",
    open: /(?:assistant\s*)?<thinking>\s*/i,
    close: /\s*<\/thinking>/i,
  },
  {
    name: "details",
    open: /<details>\s*<summary>\s*thinking\s*<\/summary>\s*/i,
    close: /\s*<\/details>/i,
  },
  {
    name: "redacted",
    open: /<\|redacted_reasoning\|>\s*/i,
    close: /\s*<\/\|redacted_reasoning\|>/i,
  },
];

/**
 * Remove leaked think markers the model sometimes pastes as plain text
 * (e.g. «раньше.assistant <think>» / bare «assistant <think>» inside thinking UI).
 *
 * CRITICAL: whitespace-only chunks (` `, `\n`) must pass through unchanged.
 * Ollama often streams a space/newline as its own delta — dropping those glued
 * Russian words (`Всеинструменты`) and smashed markdown tables onto one line.
 */
export function scrubThinkLeaks(text: string): string {
  if (!text) return text;
  if (/^\s+$/.test(text)) return text;
  return text
    // Glued role leak: «раньше.assistant <think>» / «короткоassistant <think>»
    .replace(/assistant\s*<\s*\/?\s*think(?:ing)?\s*>/gi, "")
    .replace(/<\s*\/?\s*think\s*>/gi, "")
    .replace(/<\s*\/?\s*thinking\s*>/gi, "")
    .replace(/\|?\s*redacted_reasoning\s*\|?/gi, "")
    .replace(/^\s*(?:Thinking|Reasoning)\s*:\s*/i, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Strip all known thinking wrappers from final answer text. */
export function stripThinkingTags(text: string): string {
  if (!text) return text;
  let t = text;
  for (const { open, close } of OPEN_CLOSE) {
    const re = new RegExp(
      `${open.source}[\\s\\S]*?${close.source}`,
      open.flags.includes("i") ? "gi" : "g"
    );
    t = t.replace(re, "");
  }
  // Orphan close tags (Qwen3.5 template): drop everything before last </think>
  const closeOnly = t.lastIndexOf("</think>");
  if (closeOnly >= 0 && !/<think>/i.test(t)) {
    t = t.slice(closeOnly + "</think>".length);
  }
  // Orphan opens / glued «assistant <think>» leftovers
  t = scrubThinkLeaks(t);
  // Trim only leading junk on a finished answer — never on whitespace-only
  if (/^\s+$/.test(t)) return t;
  return t.replace(/^\s+/, "");
}

export interface ThinkingSplit {
  thinking: string;
  content: string;
}

/** One-shot split of a complete assistant string. */
export function splitThinkingContent(text: string): ThinkingSplit {
  if (!text) return { thinking: "", content: "" };
  const thoughts: string[] = [];
  let rest = text;

  for (const { open, close } of OPEN_CLOSE) {
    const re = new RegExp(
      `(${open.source})([\\s\\S]*?)(${close.source})`,
      open.flags.includes("i") ? "gi" : "g"
    );
    rest = rest.replace(re, (_m, _o, body: string) => {
      const b = (body || "").trim();
      if (b) thoughts.push(b);
      return "";
    });
  }

  // Qwen3.5: chat template injects <think>; model may emit only </think>
  if (!thoughts.length) {
    const idx = rest.lastIndexOf("</think>");
    if (idx >= 0 && !/<think>/i.test(rest)) {
      const before = rest.slice(0, idx).trim();
      const after = rest.slice(idx + "</think>".length);
      if (before) thoughts.push(before);
      rest = after;
    }
  }

  return {
    thinking: thoughts.join("\n\n"),
    content: scrubThinkLeaks(rest.replace(/^\s+/, "")),
  };
}

/**
 * Streaming splitter — feed deltas, get thinking/content pieces to emit.
 * Tracks open <think> / <thinking> / details blocks across chunks.
 */
export class ThinkingTagStreamParser {
  private buf = "";
  private mode: "content" | "think" = "content";
  private activeClose: RegExp | null = null;
  /** After seeing only </think> pattern (implicit open from template) */
  private implicitThinkUntilClose = false;

  push(delta: string): { thinkingDeltas: string[]; contentDeltas: string[] } {
    const thinkingDeltas: string[] = [];
    const contentDeltas: string[] = [];
    if (!delta) return { thinkingDeltas, contentDeltas };
    this.buf += delta;

    // Emit as much as we can safely
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.mode === "think" && this.activeClose) {
        const m = this.buf.match(this.activeClose);
        if (!m || m.index === undefined) {
          // Keep a small tail in case close tag is split across chunks
          if (this.buf.length > 32) {
            const emit = this.buf.slice(0, -24);
            this.buf = this.buf.slice(-24);
            if (emit) thinkingDeltas.push(emit);
          }
          break;
        }
        const body = this.buf.slice(0, m.index);
        if (body) thinkingDeltas.push(body);
        this.buf = this.buf.slice(m.index + m[0].length);
        this.mode = "content";
        this.activeClose = null;
        this.implicitThinkUntilClose = false;
        continue;
      }

      // content mode — look for an open tag
      let best: { index: number; len: number; close: RegExp } | undefined;
      for (const { open, close } of OPEN_CLOSE) {
        const m = this.buf.match(open);
        if (m && m.index !== undefined) {
          if (!best || m.index < best.index) {
            best = { index: m.index, len: m[0].length, close };
          }
        }
      }

      // bare </think> with no prior open → everything so far was thinking (Qwen3.5)
      const bareClose = this.buf.match(/<\/think>/i);
      if (
        bareClose &&
        bareClose.index !== undefined &&
        (!best || bareClose.index < best.index) &&
        !/<think>/i.test(this.buf.slice(0, bareClose.index))
      ) {
        const before = this.buf.slice(0, bareClose.index);
        if (before) thinkingDeltas.push(before);
        this.buf = this.buf.slice(bareClose.index + bareClose[0].length);
        continue;
      }

      if (!best) {
        // Hold back possible partial tag at end
        const hold = partialTagTail(this.buf);
        const emit = this.buf.slice(0, this.buf.length - hold);
        this.buf = this.buf.slice(this.buf.length - hold);
        if (emit) contentDeltas.push(emit);
        break;
      }

      const before = this.buf.slice(0, best.index);
      if (before) contentDeltas.push(before);
      this.buf = this.buf.slice(best.index + best.len);
      this.mode = "think";
      this.activeClose = best.close;
    }

    return { thinkingDeltas, contentDeltas };
  }

  /** Flush remainder when stream ends. */
  flush(): { thinkingDeltas: string[]; contentDeltas: string[] } {
    const thinkingDeltas: string[] = [];
    const contentDeltas: string[] = [];
    if (!this.buf) return { thinkingDeltas, contentDeltas };
    if (this.mode === "think") thinkingDeltas.push(this.buf);
    else contentDeltas.push(this.buf);
    this.buf = "";
    this.mode = "content";
    this.activeClose = null;
    return { thinkingDeltas, contentDeltas };
  }
}

/** How many trailing chars may be an incomplete think/assistant leak tag. */
export function partialTagTail(s: string): number {
  const n = Math.min(64, s.length);
  const tail = s.slice(-n);
  // Hold back «assistant <thi…» mid-tag as well as bare «<thi…»
  const asst = tail.search(/assistant\s*<[\s\S]*$/i);
  if (asst >= 0 && !/>/.test(tail.slice(asst))) return n - asst;
  // Incomplete role prefix only (≥4 chars) — avoid holding a trailing «a»
  const role = tail.match(/(?:^|[^a-zA-Z])(assi(?:stant)?)$/i);
  if (role && role.index !== undefined) {
    const start = role.index + (role[0].length - role[1].length);
    return n - start;
  }
  const lt = tail.lastIndexOf("<");
  if (lt < 0) return 0;
  const frag = tail.slice(lt);
  if (
    /^<\/?(?:think|thinking|details|summary|\|redacted_reasoning\|)?[\s\S]*$/i.test(frag) &&
    !frag.includes(">")
  ) {
    return n - lt;
  }
  return 0;
}
