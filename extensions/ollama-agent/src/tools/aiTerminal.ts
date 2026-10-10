import * as vscode from "vscode";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as os from "os";

export interface AiTerminalRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Dispose leftover "AI: …" tabs from older builds. */
export function disposeAiTerminals(): void {
  for (const t of vscode.window.terminals) {
    if (/^AI:/i.test(t.name)) {
      try {
        t.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * PowerShell (WinPS 5.x) rejects `&&`. Normalize common bash-isms for the active shell.
 */
export function normalizeShellCommand(command: string): string {
  let cmd = String(command || "").trim();
  if (!cmd) return cmd;
  const isWin = process.platform === "win32";
  if (isWin) {
    // cd x && node y  →  cd x; if ($?) { node y }  is heavy — `;` is enough for sequential runs
    if (/\s&&\s/.test(cmd) && !/\bcm[dD]\s*\/c\b/.test(cmd)) {
      cmd = cmd.replace(/\s&&\s/g, "; ");
    }
  }
  return cmd;
}

function pickNativeTerminal(cwd?: string): vscode.Terminal {
  // Prefer an existing non-AI integrated terminal
  const live = vscode.window.terminals.filter(
    (t) => t.exitStatus === undefined && !/^AI:/i.test(t.name)
  );
  const active = vscode.window.activeTerminal;
  if (active && live.includes(active)) return active;
  if (live.length) return live[live.length - 1];
  return vscode.window.createTerminal({
    name: os.platform() === "win32" ? "powershell" : "bash",
    cwd: cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  });
}

/**
 * Fallback runner: native integrated terminal (no "AI:" tab) + parallel spawn for exit/output.
 * Preferred path is vscode.lm.invokeTool("run_in_terminal").
 */
export async function runInAiTerminal(
  command: string,
  cwd: string,
  opts?: { name?: string; timeoutMs?: number; newTab?: boolean }
): Promise<AiTerminalRunResult> {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const cmd = normalizeShellCommand(command);

  const term = opts?.newTab
    ? vscode.window.createTerminal({
        name: os.platform() === "win32" ? "powershell" : "bash",
        cwd,
      })
    : pickNativeTerminal(cwd);
  term.show(true);
  // Fresh shells drop the first sendText if we fire before the prompt is ready
  await new Promise((r) => setTimeout(r, opts?.newTab ? 500 : 80));
  term.sendText(cmd, true);

  return new Promise((resolve) => {
    const child: ChildProcessWithoutNullStreams = spawn(cmd, {
      cwd,
      shell: true,
      env: process.env,
    }) as ChildProcessWithoutNullStreams;

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: stdout.slice(0, 20000),
        stderr: stderr.slice(0, 10000),
        timedOut,
      });
    });
  });
}

/** @deprecated alias — clears AI tabs */
export function disposeAiTerminal(): void {
  disposeAiTerminals();
}
