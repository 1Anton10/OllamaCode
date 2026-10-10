/**
 * Remember opaque terminal execution UUIDs from run_in_terminal and
 * rewrite companion tool args when the model invents / loses the id.
 */

const UUID_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/g;

export function extractTerminalIds(text: string): string[] {
  const found = String(text || "").match(UUID_RE) || [];
  // de-dupe, keep order
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of found) {
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

export function isTerminalUuid(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
      value.trim()
    )
  );
}

export class TerminalIdTracker {
  private lastId: string | undefined;
  private lastCmd: string | undefined;
  private readonly known = new Set<string>();

  rememberFromText(text: string): string | undefined {
    const ids = extractTerminalIds(text);
    if (!ids.length) return this.lastId;
    for (const id of ids) {
      this.known.add(id.toLowerCase());
      this.lastId = id;
    }
    return this.lastId;
  }

  remember(id: string): void {
    if (!isTerminalUuid(id)) return;
    this.known.add(id.toLowerCase());
    this.lastId = id;
  }

  rememberCommand(command: string): void {
    const c = String(command || "").trim();
    if (c) this.lastCmd = c;
  }

  get last(): string | undefined {
    return this.lastId;
  }

  get lastCommand(): string | undefined {
    return this.lastCmd;
  }

  knows(id: unknown): boolean {
    return isTerminalUuid(id) && this.known.has(String(id).trim().toLowerCase());
  }

  /**
   * Ensure companion tools use a real id. Returns rewritten args + note if fixed.
   */
  rewriteCompanionArgs(
    toolName: string,
    args: Record<string, unknown>
  ): { args: Record<string, unknown>; fixed?: string } {
    if (!/terminal/i.test(toolName)) return { args };
    const raw = args.id ?? args.terminalId ?? args.terminal_id ?? args.sessionId;
    const last = this.lastId;
    if (!last) {
      if (!isTerminalUuid(raw)) {
        return {
          args,
          fixed:
            "no known terminal_id yet — run run_in_terminal (background) first, then reuse its UUID",
        };
      }
      return { args: { ...args, id: String(raw).trim() } };
    }

    if (!isTerminalUuid(raw) || !this.knows(raw)) {
      return {
        args: { ...args, id: last },
        fixed: `replaced invalid/missing id with last terminal_id=${last}`,
      };
    }
    return { args: { ...args, id: String(raw).trim() } };
  }

  /** Pin the id in TOOL_RESULT so the model cannot miss it. */
  formatPinnedIdLine(): string {
    return this.lastId ? `terminal_id: ${this.lastId}` : "";
  }
}
