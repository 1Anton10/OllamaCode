import * as vscode from "vscode";
import { ToolCall } from "./parser";
import { formatToolResult, FormattedToolResult } from "./format";
import { VscodeToolBridge, invokeVscodeTool } from "./vscodeTools";
import { normalizeShellCommand } from "./aiTerminal";
import { TerminalIdTracker, extractTerminalIds } from "./terminalIds";

/** Companion tools that need a real native terminal id from run_in_terminal. */
export const TERMINAL_COMPANION_TOOLS =
  /^(get_terminal_output|getTerminalOutput|get_terminal_last_command|getTerminalLastCommand|get_terminal_selection|getTerminalSelection|send_to_terminal|sendToTerminal|kill_terminal|killTerminal|await_terminal|read_terminal)$/i;

export const NATIVE_RUN_TERMINAL = "run_in_terminal";

/** Commands that normally never exit (bots, servers, watchers). */
export function looksLikeLongRunningCommand(command: string, why = ""): boolean {
  const c = String(command || "");
  const blob = `${c}\n${why}`.toLowerCase();
  if (!c.trim()) return false;
  if (/\b(uvicorn|gunicorn|hypercorn|waitress)\b/i.test(c)) return true;
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(start|dev|serve)\b/i.test(c)) return true;
  if (/\b(next|vite|nuxt|astro|remix)\s+dev\b/i.test(c)) return true;
  if (/\b(flask|django-admin)\b.*\brunserver\b/i.test(c) || /\bmanage\.py\s+runserver\b/i.test(c))
    return true;
  if (/\b(docker(-compose)?|compose)\s+up\b/i.test(c) && !/--abort-on-container-exit/i.test(c))
    return true;
  if (/\b(nodemon|pm2\s+start|forever\s+start|watchmedo)\b/i.test(c)) return true;
  if (/\b(aiogram|pyrogram|telethon|discord\.py|python-telegram|telegraf)\b/i.test(c)) return true;
  if (/\bpython(3)?(\.exe)?\s+[^\n]*\b(main|bot|app|server|run|webhook)\.py\b/i.test(c)) return true;
  if (/\bnode(\.exe)?\s+[^\n]*\b(server|index|app|bot)\.(js|mjs|cjs|ts)\b/i.test(c)) return true;
  if (
    /\b(бот|bot|daemon|watcher|forever|вечн|стрим|stream(ing)?|фонов|long-?running|keep\s+alive)\b/i.test(
      blob
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Force async/background for eternal processes so the agent does not block forever.
 * Also caps how long we wait for the *first* idle/output signal.
 */
export function forceBackgroundTerminalArgs(
  args: Record<string, unknown>
): Record<string, unknown> {
  const command = String(args.command ?? args.cmd ?? "");
  const why = String(args.explanation || args.goal || "");
  const already =
    args.isBackground === true ||
    args.mode === "async" ||
    String(args.mode || "").toLowerCase() === "async";
  if (already || !looksLikeLongRunningCommand(command, why)) {
    return args;
  }
  const timeout =
    typeof args.timeout === "number" && Number.isFinite(args.timeout)
      ? Math.max(5_000, Math.min(60_000, Number(args.timeout)))
      : 20_000;
  return {
    ...args,
    isBackground: true,
    mode: "async",
    timeout,
    explanation:
      String(args.explanation || args.goal || command).slice(0, 400) +
      " [auto-background: long-running]",
  };
}

export function toRunInTerminalCall(call: ToolCall): ToolCall {
  const command = normalizeShellCommand(
    String(call.arguments?.command ?? call.arguments?.cmd ?? "")
  );
  const base: Record<string, unknown> = {
    command,
    explanation: String(
      call.arguments?.explanation || call.arguments?.goal || "Run command in integrated terminal"
    ),
    goal: String(call.arguments?.goal || call.arguments?.explanation || "Run command"),
    isBackground: Boolean(call.arguments?.isBackground ?? false),
    ...(call.arguments?.mode ? { mode: call.arguments.mode } : {}),
    ...(typeof call.arguments?.timeout === "number"
      ? { timeout: call.arguments.timeout }
      : {}),
  };
  return {
    ...call,
    name: NATIVE_RUN_TERMINAL,
    arguments: forceBackgroundTerminalArgs(base),
  };
}

/** Reject empty / placeholder commands before native invoke. */
export function validateTerminalCommand(command: string): string | null {
  const c = normalizeShellCommand(command);
  if (!c) return "empty command — pass a real shell command (e.g. python main.py)";
  if (/^(pass|todo|none|n\/a|null|undefined)$/i.test(c)) {
    return `placeholder command refused: ${c}`;
  }
  return null;
}

/**
 * Strip shell chrome so we can tell "only PS prompt" from real bot/server logs.
 */
export function stripShellChrome(text: string): string {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      // PowerShell / cmd / bash prompts only
      if (/^PS\s+[A-Za-z]:\\[^>]*>\s*$/i.test(t)) return false;
      if (/^[A-Za-z]:\\[^>]*>\s*$/.test(t)) return false;
      if (/^\$\s*$/.test(t)) return false;
      if (/^[>#%]\s*$/.test(t)) return false;
      // VS Code / Copilot terminal chrome
      if (/^(Ran|Running)\s+`[^`]+`\s*$/i.test(t)) return false;
      if (/^exit\s*code\s*[:=]?\s*\d+\s*$/i.test(t)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

export function isEmptyTerminalOutput(text: string): boolean {
  return stripShellChrome(text).length === 0;
}

/**
 * Long-running bot/server launched but produced no real output and/or already exited.
 * Native tools often report "OK" with only a PS prompt — that must NOT look like a healthy start.
 */
export function diagnoseBotTerminalLaunch(opts: {
  command: string;
  why?: string;
  outputBlob: string;
  exitCode?: number | null;
  /** true = get_terminal_output poll (empty is always bad for bots) */
  isPoll?: boolean;
  background?: boolean;
}): { empty: boolean; deadExit: boolean; hint: string | null } {
  const long = looksLikeLongRunningCommand(opts.command, opts.why || "");
  if (!long) return { empty: false, deadExit: false, hint: null };

  const blob = String(opts.outputBlob || "");
  const empty = isEmptyTerminalOutput(blob);
  if (!empty) return { empty: false, deadExit: false, hint: null };

  const exitedClean =
    opts.exitCode === 0 ||
    /\bexit(?:Code|_code)?\s*[:=]?\s*0\b/i.test(blob) ||
    /\b(exited|finished|completed)\b/i.test(blob);
  const claimsStillRunning =
    /\b(continues?\s+running|still\s+running|isBackground\s*[:=]\s*true|mode\s*[:=]\s*async)\b/i.test(
      blob
    ) && !exitedClean;

  // Poll with only PS prompt → always flag
  // Sync launch with empty + exit 0 → flag
  // Background launch that already exited / no "still running" → flag
  // Background first ack still running with empty logs → allow (model must poll)
  const deadExit =
    opts.isPoll === true ||
    exitedClean ||
    (!opts.background && empty) ||
    (opts.background === true && empty && !claimsStillRunning);

  if (!deadExit) return { empty: true, deadExit: false, hint: null };

  const hint = [
    "EMPTY_OUTPUT: long-running command produced no real terminal output (only PS/cmd prompt or blank).",
    "Bot/server did NOT start successfully. Common cause: missing entrypoint",
    '`if __name__ == "__main__": asyncio.run(main())` — Python loads the file and exits 0 with zero prints.',
    "Fix: read_file the script → add entrypoint → run_in_terminal again → get_terminal_output must show ready/polling logs, not an empty prompt.",
  ].join(" ");

  return { empty: true, deadExit: true, hint };
}

function appendTerminalHint(result: FormattedToolResult, hint: string): FormattedToolResult {
  const body = result.output.replace(/\[\/TOOL_RESULT\]\s*$/, "").trim();
  return {
    ...result,
    ok: false,
    status: "FAILED",
    summary: `EMPTY_OUTPUT · ${result.summary}`.slice(0, 200),
    hint,
    output: `${body}\noutput_empty: true\nhint: ${hint}\n[/TOOL_RESULT]`,
  };
}

/**
 * After our Always Allow modal, native run_in_terminal may still show "Run pwsh?".
 * Auto-accept that card so the user only confirms once (our modal has Always Allow).
 */
async function withAutoAcceptNativeConfirm<T>(work: () => Promise<T>): Promise<T> {
  const tick = setInterval(() => {
    void vscode.commands.executeCommand("workbench.action.chat.acceptTool").then(
      () => undefined,
      () => undefined
    );
    void vscode.commands.executeCommand("workbench.action.chat.acceptElicitation").then(
      () => undefined,
      () => undefined
    );
  }, 200);
  try {
    return await work();
  } finally {
    clearInterval(tick);
  }
}

function enrichBackgroundTerminalResult(
  result: FormattedToolResult,
  args: Record<string, unknown>,
  tracker?: TerminalIdTracker
): FormattedToolResult {
  const command = String(args.command ?? args.cmd ?? "");
  const why = String(args.explanation || args.goal || "");
  const blob = `${result.summary}\n${result.detail}\n${result.output}\n${why}`;
  const ids = extractTerminalIds(blob);
  if (tracker) {
    for (const id of ids) tracker.remember(id);
  }
  const pinned = tracker?.formatPinnedIdLine() || (ids[0] ? `terminal_id: ${ids[0]}` : "");

  const bg =
    args.isBackground === true ||
    args.mode === "async" ||
    /background|async|terminal\s*id|continues running|auto-background/i.test(blob) ||
    ids.length > 0;

  // Bot/server with empty shell chrome only → FAIL loudly (do not look like success)
  const diag = diagnoseBotTerminalLaunch({
    command,
    why,
    outputBlob: blob,
    exitCode: result.exitCode,
    background: bg,
    isPoll: false,
  });
  if (diag.hint && diag.deadExit) {
    let failed = appendTerminalHint(result, diag.hint);
    if (pinned) {
      failed = {
        ...failed,
        output: `${failed.output.replace(/\[\/TOOL_RESULT\]\s*$/, "").trim()}\n${pinned}\n[/TOOL_RESULT]`,
      };
    }
    return failed;
  }

  if (!bg && !pinned) return result;

  const hint = [
    "Long-running terminal (bot/server/watcher): do NOT wait forever.",
    pinned ? `ALWAYS pass id exactly: ${pinned.replace(/^terminal_id:\s*/, "")}` : "Save terminal_id from this result.",
    "Poll get_terminal_output with that exact UUID (never invent ids).",
    "If get_terminal_output is EMPTY / only PS prompt — bot did NOT start (missing asyncio.run/main). Fix entrypoint, re-run.",
    "If healthy — leave it running in background, remember this terminal_id, continue other work (UI check, code, etc.).",
    "Do NOT kill_terminal by default — only if broken, restart needed, or user asks to stop.",
    "Never Start-Sleep / sleep waiting on it.",
  ].join(" ");

  if (/hint:\s*Long-running terminal/i.test(result.output) && /terminal_id:/i.test(result.output)) {
    return result;
  }

  const head = pinned ? `${pinned}\n` : "";
  const extra = `\n${head}hint: ${hint}`;
  return {
    ...result,
    hint,
    summary: pinned ? `${result.summary} · ${pinned}` : result.summary,
    output: `${result.output.replace(/\[\/TOOL_RESULT\]\s*$/, "").trim()}\n${extra}\n[/TOOL_RESULT]`,
  };
}

/** Invoke native run_in_terminal (real opaque ids for get_terminal_output). */
export async function invokeNativeRunInTerminal(
  call: ToolCall,
  bridge: VscodeToolBridge,
  token?: vscode.CancellationToken,
  tracker?: TerminalIdTracker
): Promise<FormattedToolResult> {
  const rit = toRunInTerminalCall(call);
  const cmd = String(rit.arguments?.command || "");
  const bad = validateTerminalCommand(cmd);
  if (bad) {
    return formatToolResult({
      call: rit,
      status: "FAILED",
      summary: bad,
      detail: bad,
      hint: "Put the full command in arguments.command, e.g. python main.py",
    });
  }
  const result = await withAutoAcceptNativeConfirm(() => invokeVscodeTool(rit, bridge, token));
  if (tracker) tracker.rememberCommand(cmd);
  const enriched = enrichBackgroundTerminalResult(result, rit.arguments || {}, tracker);
  // Surface the exact command so the model can't claim it ran something else
  if (!/command:\s*/i.test(enriched.output)) {
    const note = `command: ${cmd}`;
    return {
      ...enriched,
      summary: enriched.ok
        ? `${enriched.summary} · ran: ${cmd.slice(0, 80)}`
        : `${enriched.summary} · attempted: ${cmd.slice(0, 80)}`,
      output: `${enriched.output.replace(/\[\/TOOL_RESULT\]\s*$/, "").trim()}\n${note}\n[/TOOL_RESULT]`,
    };
  }
  return enriched;
}

/**
 * Rewrite companion tool args to the last known terminal UUID, then invoke.
 * await_terminal is local: polls native get_terminal_output until pattern/timeout.
 */
export async function invokeTerminalCompanion(
  call: ToolCall,
  bridge: VscodeToolBridge,
  tracker: TerminalIdTracker,
  token?: vscode.CancellationToken
): Promise<FormattedToolResult> {
  if (/^await_terminal$/i.test(call.name)) {
    return awaitTerminalPattern(call, bridge, tracker, token);
  }

  const { args, fixed } = tracker.rewriteCompanionArgs(call.name, {
    ...(call.arguments || {}),
  });
  const patched: ToolCall = { ...call, arguments: args };
  let result = await invokeVscodeTool(patched, bridge, token);

  const idFailed =
    !result.ok &&
    /invalid|unknown|not found|no terminal|pattern|uuid|id/i.test(
      `${result.summary}\n${result.detail}\n${result.output}`
    );

  if (idFailed && tracker.last && String(args.id || "") !== tracker.last) {
    const retryArgs = { ...args, id: tracker.last };
    result = await invokeVscodeTool(
      { ...call, arguments: retryArgs },
      bridge,
      token
    );
    const note = `auto-retry with terminal_id=${tracker.last}`;
    result = {
      ...result,
      summary: `${result.summary} · ${note}`,
      output: `${result.output.replace(/\[\/TOOL_RESULT\]\s*$/, "").trim()}\nhint: ${note}\n[/TOOL_RESULT]`,
    };
  } else if (fixed && result.ok) {
    result = {
      ...result,
      summary: `${result.summary} · ${fixed}`,
      output: `${result.output.replace(/\[\/TOOL_RESULT\]\s*$/, "").trim()}\nhint: ${fixed}\n[/TOOL_RESULT]`,
    };
  } else if (fixed && !tracker.last) {
    result = formatToolResult({
      call,
      status: "FAILED",
      summary: "terminal id missing",
      detail: fixed,
      hint: "Call run_in_terminal first (background for bots), copy terminal_id from TOOL_RESULT, then get_terminal_output.",
    });
  }

  // Successful polls still remember id if echoed
  tracker.rememberFromText(`${result.detail}\n${result.output}`);

  // Empty poll after bot launch — tell the model clearly
  if (/^get_terminal_output$/i.test(call.name) || /^getTerminalOutput$/i.test(call.name)) {
    const lastCmd = tracker.lastCommand || "python main.py";
    const diag = diagnoseBotTerminalLaunch({
      command: lastCmd,
      outputBlob: `${result.summary}\n${result.detail}\n${result.output}`,
      background: true,
      isPoll: true,
    });
    if (diag.hint && diag.deadExit) {
      result = appendTerminalHint(result, diag.hint);
    }
  }

  return result;
}

function sleep(ms: number, token?: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve, reject) => {
    if (token?.isCancellationRequested) {
      reject(new Error("cancelled"));
      return;
    }
    const t = setTimeout(resolve, ms);
    token?.onCancellationRequested(() => {
      clearTimeout(t);
      reject(new Error("cancelled"));
    });
  });
}

/** Astra AwaitShell subset: poll get_terminal_output until regex / done / timeout. */
async function awaitTerminalPattern(
  call: ToolCall,
  bridge: VscodeToolBridge,
  tracker: TerminalIdTracker,
  token?: vscode.CancellationToken
): Promise<FormattedToolResult> {
  const { args, fixed } = tracker.rewriteCompanionArgs("get_terminal_output", {
    ...(call.arguments || {}),
    id: call.arguments?.id || call.arguments?.terminal_id || call.arguments?.terminalId,
  });
  const id = String(args.id || "").trim();
  if (!id) {
    return formatToolResult({
      call,
      status: "FAILED",
      summary: "terminal id missing",
      detail: fixed || "pass id / terminal_id from run_in_terminal",
      hint: "run_in_terminal (background) → copy terminal_id → await_terminal",
    });
  }

  const patternRaw = String(call.arguments?.pattern || "").trim();
  let re: RegExp | null = null;
  if (patternRaw) {
    try {
      re = new RegExp(patternRaw, "m");
    } catch (e: any) {
      return formatToolResult({
        call,
        status: "FAILED",
        summary: "invalid pattern regex",
        detail: String(e?.message || e),
      });
    }
  }

  // Long-running bots/servers: allow up to 20 minutes (Cursor-style AwaitShell budget)
  const timeoutMs = Math.min(
    1_200_000,
    Math.max(1_000, Number(call.arguments?.timeout_ms ?? call.arguments?.timeout ?? 60_000) || 60_000)
  );
  const started = Date.now();
  let lastBlob = "";
  let polls = 0;

  while (Date.now() - started < timeoutMs) {
    if (token?.isCancellationRequested) {
      return formatToolResult({
        call,
        status: "FAILED",
        summary: "await_terminal cancelled",
        detail: lastBlob.slice(-4000),
      });
    }
    polls += 1;
    const pollCall: ToolCall = {
      id: `${call.id}_poll_${polls}`,
      name: "get_terminal_output",
      arguments: { id },
      source: call.source,
      raw: call.raw,
    };
    const poll = await invokeVscodeTool(pollCall, bridge, token);
    lastBlob = `${poll.summary}\n${poll.detail}\n${poll.output}`;
    tracker.rememberFromText(lastBlob);

    const exited =
      /\bexit(?:Code|_code)?\s*[:=]?\s*-?\d+\b/i.test(lastBlob) ||
      /\b(exited|finished|completed|terminated)\b/i.test(lastBlob);
    const matched = re ? re.test(lastBlob) : false;

    if (matched) {
      return formatToolResult({
        call,
        status: "OK",
        action: "OTHER",
        summary: `await_terminal matched after ${polls} poll(s) · ${Date.now() - started}ms`,
        detail: lastBlob.slice(-8000),
        hint: `pattern matched: /${patternRaw}/`,
      });
    }
    if (!re && exited) {
      return formatToolResult({
        call,
        status: "OK",
        action: "OTHER",
        summary: `await_terminal process ended after ${polls} poll(s)`,
        detail: lastBlob.slice(-8000),
      });
    }
    if (re && exited) {
      return formatToolResult({
        call,
        status: "FAILED",
        summary: "await_terminal ended without pattern match",
        detail: lastBlob.slice(-8000),
        hint: `pattern not found before exit: /${patternRaw}/`,
      });
    }

    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) break;
    try {
      await sleep(Math.min(1500, remaining), token);
    } catch {
      return formatToolResult({
        call,
        status: "FAILED",
        summary: "await_terminal cancelled",
        detail: lastBlob.slice(-4000),
      });
    }
  }

  return formatToolResult({
    call,
    status: "FAILED",
    summary: `await_terminal timeout after ${polls} poll(s) · ${timeoutMs}ms`,
    detail: lastBlob.slice(-8000),
    hint: re
      ? `pattern not matched: /${patternRaw}/ — try get_terminal_output or raise timeout_ms`
      : "no exit signal within timeout — process may still be running",
  });
}

export function denyTerminal(call: ToolCall, reason: string): FormattedToolResult {
  return formatToolResult({
    call,
    status: "DENIED",
    summary: reason,
    detail: reason,
  });
}
