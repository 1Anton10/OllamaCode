import * as vscode from "vscode";
import {
  resolveWorkspaceRoot,
  switchWorkspaceFolderInPlace,
  setAgentRoot,
} from "../agent/agentRoot";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ToolCall } from "./parser";
import { OllamaCodeConfig, persistAutoApprove } from "../config";
import { formatToolResult, FormattedToolResult, ToolAction } from "./format";
import { isRepeatFailure, recordToolAttempt } from "./antiLoop";
import { normalizeShellCommand, runInAiTerminal } from "./aiTerminal";
import { secretWriteHint } from "./secretsHint";
import { confirmWindowsDesktop, runWindowsDesktop } from "./windowsDesktop";
import { buildRepoMap, getRepoMapSummary } from "../index/repoMap";
import { upsertTask, listTasks, formatTaskBoard } from "../agent/tasks";
import { vctxListIndex, vctxRecall } from "../agent/chunkedContext";
import { SubagentPool, defaultWaitForMode, SubMode } from "../agent/subagentPool";
import { resolveReadWindow } from "./readWindow";
import { formatWebSearchHits, runWebSearch } from "./webSearch";

export type ToolResult = FormattedToolResult;

export type ExecuteToolOptions = {
  /** @deprecated prefer subPool */
  runSubagent?: (goal: string, mode: string) => Promise<string>;
  subPool?: SubagentPool;
  /** Confirmation already done (native chat Always Allow / prepareInvocation). */
  skipConfirm?: boolean;
};

function workspaceRoot(): string {
  return resolveWorkspaceRoot();
}

function resolvePath(p: string): string {
  if (!p) return workspaceRoot();
  return path.isAbsolute(p) ? p : path.join(workspaceRoot(), p);
}

/** Exported for native terminal bridge (Always Allow before run_in_terminal). */
export async function confirmToolPermission(
  cfg: OllamaCodeConfig,
  kind: "read" | "write" | "terminal",
  detail: string,
  skipConfirm?: boolean
): Promise<boolean> {
  if (skipConfirm) return true;
  if (kind === "read" && cfg.tools.autoApproveRead) return true;
  if (kind === "write" && cfg.tools.autoApproveWrite) return true;
  if (kind === "terminal" && cfg.tools.autoApproveTerminal) return true;
  const title =
    kind === "terminal"
      ? `Run terminal command?\n\n${detail.slice(0, 800)}`
      : `OllamaCode tool (${kind}): ${detail}`;
  const pick = (await vscode.window.showWarningMessage(
    title,
    { modal: true },
    "Allow",
    "Always Allow",
    "Deny"
  )) as string | undefined;
  if (pick === "Always Allow") {
    if (kind === "read") cfg.tools.autoApproveRead = true;
    if (kind === "write") cfg.tools.autoApproveWrite = true;
    if (kind === "terminal") cfg.tools.autoApproveTerminal = true;
    persistAutoApprove(kind);
    void vscode.window.showInformationMessage(
      kind === "terminal"
        ? "Terminal commands: Always Allow (saved)."
        : kind === "write"
          ? "File writes: Always Allow (saved)."
          : "Reads: Always Allow (saved)."
    );
    return true;
  }
  return pick === "Allow";
}

function deny(call: ToolCall, reason: string): ToolResult {
  recordToolAttempt(call, "DENIED");
  return formatToolResult({
    call,
    status: "DENIED",
    summary: reason,
    detail: reason,
  });
}

function fail(call: ToolCall, summary: string, detail?: string, pathHint?: string): ToolResult {
  recordToolAttempt(call, "FAILED");
  return formatToolResult({
    call,
    status: "FAILED",
    summary,
    detail,
    path: pathHint,
  });
}

export async function executeTool(
  call: ToolCall,
  cfg: OllamaCodeConfig,
  opts?: ExecuteToolOptions & { subagent?: boolean }
): Promise<ToolResult> {
  const skipConfirm = Boolean(opts?.skipConfirm);
  try {
    // Anti-loop: block repeating the exact same failed invocation
    if (isRepeatFailure(call)) {
      recordToolAttempt(call, "BLOCKED");
      return formatToolResult({
        call,
        status: "BLOCKED",
        summary: "повтор той же упавшей команды заблокирован",
        hint:
          "Та же команда уже падала. Другой tool/args: файл → read_file; секрет → попроси токен у пользователя. Не крути вхолостую.",
      });
    }

    switch (call.name) {
      case "execute_command":
      case "run_in_terminal": {
        const command = normalizeShellCommand(String(call.arguments.command || ""));
        if (!command) return fail(call, "empty command");
        if (!(await confirmToolPermission(cfg, "terminal", command, skipConfirm)))
          return deny(call, "denied by user");

        // Fallback only — preferred path is native vscode.lm run_in_terminal
        const result = await runInAiTerminal(command, workspaceRoot(), {
          newTab: Boolean(call.arguments.new_tab),
        });
        const detail = `exit=${result.exitCode}${result.timedOut ? " timeout" : ""}\n${result.stdout}${result.stderr}`.slice(
          0,
          20000
        );
        const { diagnoseBotTerminalLaunch } = await import("./nativeTerminalBridge");
        const diag = diagnoseBotTerminalLaunch({
          command,
          why: String(call.arguments.explanation || ""),
          outputBlob: detail,
          exitCode: result.exitCode,
          background: false,
        });
        const emptyFail = Boolean(diag.deadExit && diag.hint);
        const ok = !emptyFail && !result.timedOut && result.exitCode === 0;
        recordToolAttempt(call, ok ? "OK" : "FAILED", result.exitCode ?? undefined);
        return formatToolResult({
          call,
          status: ok ? "OK" : "FAILED",
          action: "RAN",
          summary: emptyFail
            ? `EMPTY_OUTPUT exit=${result.exitCode}`
            : ok
              ? `command ok exit=${result.exitCode}`
              : `command failed exit=${result.exitCode}`,
          detail: emptyFail ? `${detail}\noutput_empty: true` : detail,
          exitCode: result.exitCode ?? undefined,
          hint: emptyFail
            ? diag.hint!
            : "Fallback runner (native run_in_terminal unavailable). Output inline.",
        });
      }

      case "windows_desktop": {
        const action = String(call.arguments.action || "");
        const detail = [action, call.arguments.target, call.arguments.title, call.arguments.text]
          .filter(Boolean)
          .join(" · ");
        if (!skipConfirm && !(await confirmWindowsDesktop(detail || action))) {
          return deny(call, "denied by user");
        }
        const raw = await runWindowsDesktop(call.arguments || {});
        const ok = /status: OK/i.test(raw);
        recordToolAttempt(call, ok ? "OK" : "FAILED");
        return {
          call,
          ok,
          status: ok ? "OK" : "FAILED",
          summary: ok ? `windows_desktop ${action} ok` : `windows_desktop ${action} failed`,
          detail: raw.slice(0, 12000),
          output: raw,
          action: "OTHER",
        };
      }

      case "read_file": {
        const p = resolvePath(String(call.arguments.path || ""));
        const offset = Math.max(0, Number(call.arguments.offset || 0));
        const limit = Math.max(0, Number(call.arguments.limit || 0));
        if (!(await confirmToolPermission(cfg, "read", p, skipConfirm))) return deny(call, "denied by user");
        if (!fs.existsSync(p)) return fail(call, `not found: ${p}`, undefined, p);
        const raw = fs.readFileSync(p, "utf8");
        const win = resolveReadWindow({ text: raw, offset, limit });
        recordToolAttempt(call, "OK");
        return formatToolResult({
          call,
          status: "OK",
          path: p,
          action: "READ",
          summary: win.summary,
          detail: win.body,
          hint: win.hint,
          ui: { kind: "read", path: p },
        });
      }

      case "write_to_file": {
        const p = resolvePath(String(call.arguments.path || ""));
        const content = String(call.arguments.content ?? "");
        if (!(await confirmToolPermission(cfg, "write", p, skipConfirm))) return deny(call, "denied by user");
        const existed = fs.existsSync(p);
        const before = existed ? fs.readFileSync(p, "utf8") : "";
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, "utf8");
        const action: ToolAction = existed ? "UPDATED" : "CREATED";
        const secretHint = secretWriteHint(p, content);
        recordToolAttempt(call, "OK");
        return formatToolResult({
          call,
          status: "OK",
          path: p,
          action,
          summary: secretHint
            ? `${action.toLowerCase()} ${content.length} bytes (placeholder secret — warn user)`
            : `${action.toLowerCase()} ${content.length} bytes`,
          detail: `${action} ${p} (${content.length} chars)`,
          hint: secretHint,
          ui: { kind: "edit", path: p, before, after: content },
        });
      }

      case "replace_in_file": {
        const p = resolvePath(String(call.arguments.path || ""));
        const oldText = String(call.arguments.old_string ?? call.arguments.old ?? "");
        const newText = String(call.arguments.new_string ?? call.arguments.new ?? "");
        if (!oldText) return fail(call, "old_string required", undefined, p);
        if (!(await confirmToolPermission(cfg, "write", p, skipConfirm))) return deny(call, "denied by user");
        if (!fs.existsSync(p)) return fail(call, `not found: ${p}`, undefined, p);
        const raw = fs.readFileSync(p, "utf8");
        if (!raw.includes(oldText)) {
          return fail(call, "old_string not found", raw.slice(0, 500), p);
        }
        const next = raw.replace(oldText, newText);
        if (next === raw) {
          recordToolAttempt(call, "OK");
          return formatToolResult({
            call,
            status: "OK",
            path: p,
            action: "UNCHANGED",
            summary: "no change",
            ui: { kind: "edit", path: p, before: raw, after: raw },
          });
        }
        fs.writeFileSync(p, next, "utf8");
        recordToolAttempt(call, "OK");
        return formatToolResult({
          call,
          status: "OK",
          path: p,
          action: "UPDATED",
          summary: `replaced ${oldText.length}→${newText.length} chars`,
          ui: { kind: "edit", path: p, before: raw, after: next },
        });
      }

      case "list_files": {
        const p = resolvePath(String(call.arguments.path || "."));
        if (!(await confirmToolPermission(cfg, "read", p, skipConfirm))) return deny(call, "denied by user");
        if (!fs.existsSync(p)) return fail(call, `not found: ${p}`, undefined, p);
        const readEntries = (dir: string, limit: number) => {
          try {
            return fs
              .readdirSync(dir, { withFileTypes: true })
              .filter((e) => e.name !== ".git" && e.name !== "node_modules")
              .sort((a, b) => {
                const ad = a.isDirectory() ? 0 : 1;
                const bd = b.isDirectory() ? 0 : 1;
                if (ad !== bd) return ad - bd;
                return a.name.localeCompare(b.name);
              })
              .slice(0, limit);
          } catch {
            return [] as fs.Dirent[];
          }
        };
        const MAX_TOP = 36;
        const MAX_CHILD = 28;
        const all = readEntries(p, 500);
        const top = all.slice(0, MAX_TOP);
        const lines = all.map((e) => `${e.isDirectory() ? "dir" : "file"}\t${e.name}`);
        const uiEntries = top.map((e) => {
          if (!e.isDirectory()) return { name: e.name, dir: false as const };
          const kids = readEntries(path.join(p, e.name), MAX_CHILD).map((c) => ({
            name: c.name,
            dir: c.isDirectory(),
          }));
          return { name: e.name, dir: true as const, children: kids };
        });
        const truncated = Math.max(0, all.length - top.length);
        recordToolAttempt(call, "OK");
        return formatToolResult({
          call,
          status: "OK",
          path: p,
          action: "OTHER",
          summary:
            truncated > 0
              ? `${all.length} entries (UI shows ${top.length})`
              : `${all.length} entries`,
          detail: lines.join("\n"),
          ui: {
            kind: "filetree",
            path: p,
            entries: uiEntries,
            truncated,
          },
        });
      }

      case "search_files": {
        const root = resolvePath(String(call.arguments.path || "."));
        const regex = new RegExp(String(call.arguments.regex || ""), "i");
        if (!(await confirmToolPermission(cfg, "read", root, skipConfirm))) return deny(call, "denied by user");
        const hits: string[] = [];
        const walk = (dir: string, depth: number) => {
          if (depth > 4 || hits.length > 80) return;
          let entries: fs.Dirent[] = [];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "out") continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full, depth + 1);
            else if (regex.test(e.name) || regex.test(full)) hits.push(full);
          }
        };
        walk(root, 0);
        recordToolAttempt(call, "OK");
        return formatToolResult({
          call,
          status: "OK",
          action: "SEARCHED",
          summary: `${hits.length} path hits`,
          detail: hits.join("\n") || "(no hits)",
        });
      }

      case "grep": {
        const query = String(call.arguments.query || call.arguments.pattern || "");
        if (!query) return fail(call, "query required");
        if (!(await confirmToolPermission(cfg, "read", workspaceRoot(), skipConfirm))) return deny(call, "denied by user");
        // Hard cap — model often asks for hundreds of hits and then context dies (Qwen 500).
        const maxResults = Math.min(40, Math.max(1, Number(call.arguments.max_results || 40) || 40));
        let re: RegExp;
        try {
          re = new RegExp(query, "i");
        } catch {
          return fail(call, "invalid regex");
        }
        const hits: string[] = [];
        const walk = (dir: string, depth: number) => {
          if (depth > 6 || hits.length >= maxResults) return;
          let entries: fs.Dirent[] = [];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            if (IGNORE_NAME(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
              walk(full, depth + 1);
              continue;
            }
            try {
              const st = fs.statSync(full);
              if (st.size > 400_000) continue;
              const text = fs.readFileSync(full, "utf8");
              const lines = text.split(/\r?\n/);
              for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
                if (re.test(lines[i])) {
                  hits.push(`${full}:${i + 1}: ${lines[i].slice(0, 200)}`);
                }
              }
            } catch {
              /* binary / unreadable */
            }
          }
        };
        walk(workspaceRoot(), 0);
        recordToolAttempt(call, "OK");
        return formatToolResult({
          call,
          status: "OK",
          action: "SEARCHED",
          summary: `${hits.length} matches`,
          detail: hits.join("\n") || "(no hits)",
        });
      }

      case "get_diagnostics": {
        const p = call.arguments.path
          ? resolvePath(String(call.arguments.path))
          : undefined;
        const uris = p
          ? [vscode.Uri.file(p)]
          : vscode.workspace.textDocuments.map((d) => d.uri);
        const lines: string[] = [];
        for (const uri of uris.slice(0, 30)) {
          for (const d of vscode.languages.getDiagnostics(uri)) {
            lines.push(
              `${uri.fsPath}:${d.range.start.line + 1} [${vscode.DiagnosticSeverity[d.severity]}] ${d.message}`
            );
          }
        }
        recordToolAttempt(call, "OK");
        return formatToolResult({
          call,
          status: "OK",
          action: "OTHER",
          summary: `${lines.length} diagnostics`,
          detail: lines.slice(0, 80).join("\n") || "(clean)",
          path: p,
        });
      }

      case "open_file": {
        const p = resolvePath(String(call.arguments.path || ""));
        if (!fs.existsSync(p)) return fail(call, `not found: ${p}`, undefined, p);
        const doc = await vscode.workspace.openTextDocument(p);
        await vscode.window.showTextDocument(doc, { preview: true });
        recordToolAttempt(call, "OK");
        return formatToolResult({
          call,
          status: "OK",
          path: p,
          action: "OTHER",
          summary: "opened in editor",
        });
      }

      case "fork_project_workspace": {
        const src = workspaceRoot();
        if (!src || !fs.existsSync(src)) return fail(call, "no current workspace to fork");
        const raw = String(call.arguments.path || call.arguments.folder || "").trim();
        const dest = path.isAbsolute(raw)
          ? raw
          : raw
            ? path.join(path.dirname(src), raw)
            : path.join(path.dirname(src), `${path.basename(src)}-fork`);
        const newWindow = call.arguments.new_window === undefined ? true : Boolean(call.arguments.new_window);
        const keepGit = call.arguments.keep_git === undefined ? true : Boolean(call.arguments.keep_git);
        if (!(await confirmToolPermission(cfg, "write", dest, skipConfirm))) return deny(call, "denied by user");
        try {
          if (fs.existsSync(dest)) {
            return fail(call, `destination already exists: ${dest}`, undefined, dest);
          }
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const skip = new Set(["node_modules", ".next", "dist", "out", "coverage", ".turbo"]);
          if (!keepGit) skip.add(".git");
          fs.cpSync(src, dest, {
            recursive: true,
            filter: (p) => {
              const base = path.basename(p);
              if (skip.has(base)) return false;
              if (base === ".ollamacode") return false;
              return true;
            },
          });
          const uri = vscode.Uri.file(dest);
          setTimeout(() => {
            void vscode.commands.executeCommand("vscode.openFolder", uri, {
              forceNewWindow: newWindow,
            });
          }, 250);
          recordToolAttempt(call, "OK");
          return formatToolResult({
            call,
            status: "OK",
            path: dest,
            action: "CREATED",
            summary: `forked → ${dest}`,
            detail: `Copied from ${src} (skipped node_modules${keepGit ? "" : ", .git"}). Opening ${
              newWindow ? "new window" : "same window"
            }.`,
          });
        } catch (e: any) {
          return fail(call, `fork failed: ${e?.message || e}`, undefined, dest);
        }
      }

      case "move_chat_workspace":
      case "open_workspace":
      case "create_project_workspace": {
        const raw = String(call.arguments.path || call.arguments.folder || "").trim();
        if (!raw) return fail(call, "path required");
        const folder = path.isAbsolute(raw)
          ? raw
          : path.join(os.homedir(), "Projects", raw);
        const isMoveChat =
          call.name === "move_chat_workspace" || Boolean(call.arguments.move_chat);
        const create =
          call.name === "create_project_workspace" ||
          Boolean(call.arguments.create) ||
          (isMoveChat && Boolean(call.arguments.create));
        // Hard reload (openFolder) only when explicitly requested — kills in-flight chat.
        const hardReload = Boolean(call.arguments.reload || call.arguments.hard);
        const newWindow =
          call.arguments.new_window === undefined
            ? call.name === "create_project_workspace"
            : Boolean(call.arguments.new_window);
        try {
          const current =
            vscode.workspace.workspaceFolders?.map((f) =>
              path.normalize(f.uri.fsPath)
            ) || [];
          const norm = path.normalize(folder);
          if (
            current.some((c) => c.toLowerCase() === norm.toLowerCase()) &&
            path.normalize(workspaceRoot()).toLowerCase() === norm.toLowerCase()
          ) {
            setAgentRoot(norm);
            recordToolAttempt(call, "OK");
            return formatToolResult({
              call,
              status: "OK",
              path: folder,
              action: "UNCHANGED",
              summary: "уже открыт текущий workspace",
              hint: "Пиши файлы через write_to_file.",
            });
          }
          if (create) {
            fs.mkdirSync(folder, { recursive: true });
            const readme = path.join(folder, "README.md");
            if (!fs.existsSync(readme)) {
              fs.writeFileSync(
                readme,
                `# ${path.basename(folder)}\n\nCreated by OllamaCode agent.\n`,
                "utf8"
              );
            }
          } else if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
            return fail(call, `folder not found: ${folder}`, undefined, folder);
          }

          // Default path: in-place switch (no window reload) so this tool result
          // reaches the model. openFolder only for hardReload / new_window.
          // Always migrate chatSessions on disk so a later window reload keeps the chat
          // (host transferActiveChat is often a stub; LIVE_FOLDER id change would otherwise → 0 chats).
          let migrateNote = "";
          if (isMoveChat) {
            try {
              const { migrateChatSessionsToFolder } = await import(
                "../agent/chatWorkspaceTransfer"
              );
              const mig = migrateChatSessionsToFolder(norm);
              migrateNote = mig.detail;
            } catch (me: any) {
              migrateNote = `chat migrate skipped: ${me?.message || me}`;
            }
          }

          if (!hardReload && !newWindow) {
            const sw = switchWorkspaceFolderInPlace(norm);
            recordToolAttempt(call, "OK");
            return formatToolResult({
              call,
              status: "OK",
              path: folder,
              action: "OTHER",
              summary: isMoveChat
                ? `chat stays; workspace → ${folder} (${sw.mode})`
                : `workspace → ${folder} (${sw.mode})`,
              hint: [sw.note, migrateNote].filter(Boolean).join(" · "),
            });
          }

          const uri = vscode.Uri.file(folder);
          let transferNote = "chat not transferred (open folder only)";
          if (isMoveChat) {
            const transfer = (
              vscode as typeof vscode & {
                interactive?: {
                  transferActiveChat?: (u: vscode.Uri) => Thenable<void>;
                };
              }
            ).interactive?.transferActiveChat;
            if (typeof transfer === "function") {
              try {
                await transfer(uri);
                transferNote =
                  "chat session queued for transfer (API) + disk migrate for reload";
              } catch (te: any) {
                transferNote = `transferActiveChat failed: ${te?.message || te} — disk migrate: ${migrateNote || "n/a"}`;
              }
            } else {
              transferNote = `transferActiveChat stub/unavailable — disk migrate: ${migrateNote || "n/a"}`;
            }
          }

          setAgentRoot(norm);
          setTimeout(() => {
            void vscode.commands.executeCommand("vscode.openFolder", uri, {
              forceNewWindow: newWindow,
            });
          }, 250);
          recordToolAttempt(call, "OK");
          return formatToolResult({
            call,
            status: "OK",
            path: folder,
            action: "OTHER",
            summary: isMoveChat
              ? `hard reload → ${folder}`
              : newWindow
                ? `opening new window → ${folder}`
                : `reloading window → ${folder}`,
            hint: `${transferNote}. Prefer default move_chat_workspace without reload=true.`,
          });
        } catch (e: any) {
          return fail(call, e?.message || String(e), undefined, folder);
        }
      }

      case "run_subagent": {
        if (opts?.subagent) {
          return fail(call, "nested subagent forbidden");
        }
        const goal = String(call.arguments.goal || call.arguments.prompt || "");
        if (!goal) return fail(call, "goal required");
        const modeRaw = String(call.arguments.mode || "read").toLowerCase();
        const mode: SubMode = modeRaw === "implement" ? "implement" : "read";
        // Explicit wait wins; else: implement→wait (native plaque), read→background
        const wait = defaultWaitForMode(mode, call.arguments.wait);

        if (opts?.subPool) {
          const out = await opts.subPool.spawn(goal, mode, wait);
          if (out.status === "running") {
            recordToolAttempt(call, "OK");
            return formatToolResult({
              call,
              status: "RUNNING",
              action: "OTHER",
              summary: `subagent ${out.id} started in background`,
              detail: [
                `id: ${out.id}`,
                `mode: ${mode}`,
                `wait: false`,
                `goal: ${goal.slice(0, 400)}`,
                "Background = no VS Code Summoning plaque (local pool). Parent UI is free.",
                "Continue other work OR await_subagent(id). Result also auto-injects as [SUBAGENT_DONE].",
                "Want the native plaque? Call again with wait=true (or mode=implement).",
              ].join("\n"),
              hint: `Background ${out.id}. await_subagent when you need the result; do not idle.`,
            });
          }
          recordToolAttempt(call, out.status === "failed" ? "FAILED" : "OK");
          return formatToolResult({
            call,
            status: out.status === "failed" ? "FAILED" : "OK",
            action: "OTHER",
            summary:
              out.status === "failed"
                ? `subagent ${out.id} failed`
                : `subagent ${out.id} finished`,
            detail: [
              `wait: true · native plaque when Built-In runSubagent available`,
              out.result || out.error || "",
              out.status === "failed"
                ? "hint: Continue yourself with tools now. Do not stop text-only."
                : "hint: Relay this result to the user in chat (subagent cannot write the parent UI).",
            ]
              .filter(Boolean)
              .join("\n"),
            path: out.id,
            hint:
              out.status === "failed"
                ? "Subagent failed — keep working with your own tools."
                : undefined,
          });
        }

        // Legacy sync path
        if (!opts?.runSubagent) return fail(call, "subagent runner not wired");
        const text = await opts.runSubagent(goal, mode);
        recordToolAttempt(call, "OK");
        return formatToolResult({
          call,
          status: "OK",
          action: "OTHER",
          summary: "subagent finished",
          detail: text,
        });
      }

      case "await_subagent": {
        if (opts?.subagent) return fail(call, "nested subagent forbidden");
        if (!opts?.subPool) return fail(call, "subagent pool not wired");
        const id = String(call.arguments.id || call.arguments.job_id || "").trim();
        if (!id) return fail(call, "id required (from run_subagent)");
        const timeout = Math.min(
          1_200_000,
          Math.max(1_000, Number(call.arguments.timeout_ms || 180_000) || 180_000)
        );
        const out = await opts.subPool.awaitJob(id, timeout);
        recordToolAttempt(call, out.status === "failed" ? "FAILED" : "OK");
        return formatToolResult({
          call,
          status: out.status === "failed" ? "FAILED" : "OK",
          action: "OTHER",
          summary:
            out.status === "running"
              ? `subagent ${id} still running`
              : out.status === "failed"
                ? `subagent ${id} failed`
                : `subagent ${id} ready`,
          detail: out.result || out.error || JSON.stringify(out),
          path: id,
        });
      }

      case "list_subagents": {
        if (!opts?.subPool) return fail(call, "subagent pool not wired");
        const rows = opts.subPool.list();
        recordToolAttempt(call, "OK");
        return formatToolResult({
          call,
          status: "OK",
          action: "OTHER",
          summary: `${rows.length} subagent job(s)`,
          detail: rows.length
            ? rows
                .map(
                  (r) =>
                    `${r.id}\t${r.status}\t${r.mode}\t${r.ms}ms\t${r.goal}`
                )
                .join("\n")
            : "(none)",
        });
      }

      case "ask_followup_question": {
        const q = String(call.arguments.question || "");
        const answer = await vscode.window.showInputBox({ prompt: q });
        recordToolAttempt(call, "OK");
        return formatToolResult({
          call,
          status: "OK",
          summary: "user answered",
          detail: answer ?? "(no answer)",
        });
      }

      case "vctx_index": {
        const limit = Math.min(200, Math.max(5, Number(call.arguments.limit || 40)));
        const detail = vctxListIndex(limit);
        recordToolAttempt(call, "OK");
        return formatToolResult({
          call,
          status: "OK",
          action: "SEARCHED",
          summary: `VCTX index (≤${limit} rows)`,
          detail:
            "Каждая строка — отдельный слот. Чтобы получить ПОЛНЫЙ текст: vctx_recall с ids=[...].\n" +
            detail,
        });
      }

      case "vctx_recall": {
        let ids: string[] | undefined;
        const rawIds = call.arguments.ids;
        if (Array.isArray(rawIds)) {
          ids = rawIds.map(String).filter(Boolean);
        } else if (typeof rawIds === "string" && rawIds.trim()) {
          ids = rawIds
            .split(/[\s,;]+/)
            .map((s) => s.trim())
            .filter(Boolean);
        }
        const result = vctxRecall({
          query: call.arguments.query ? String(call.arguments.query) : undefined,
          ids,
          maxItems: call.arguments.max_items ? Number(call.arguments.max_items) : undefined,
          maxCharsPerItem: call.arguments.max_chars
            ? Number(call.arguments.max_chars)
            : undefined,
        });
        if (!result.ok) return fail(call, result.error);
        const detail =
          result.hits.length === 0
            ? `(no hits) indexSize=${result.indexSize}\n${result.note}`
            : result.hits.map((h) => h.content).join("\n\n") +
              `\n\n--- meta: ${result.note}; truncated=${result.hits.filter((h) => h.truncated).length} ---`;
        recordToolAttempt(call, "OK");
        return formatToolResult({
          call,
          status: "OK",
          action: "SEARCHED",
          summary: `VCTX ${result.hits.length} slot(s)`,
          detail,
        });
      }

      case "web_search": {
        const query = String(
          call.arguments.query || call.arguments.search_term || call.arguments.q || ""
        ).trim();
        const maxResults = Number(call.arguments.max_results || call.arguments.maxResults || 5);
        if (!(await confirmToolPermission(cfg, "read", `web_search: ${query}`, skipConfirm))) {
          return deny(call, "web_search denied");
        }
        const res = await runWebSearch(query, maxResults);
        if (!res.ok) return fail(call, res.error);
        recordToolAttempt(call, "OK");
        return formatToolResult({
          call,
          status: "OK",
          action: "SEARCHED",
          summary: `web_search ${res.hits.length} hit(s)`,
          detail: formatWebSearchHits(res.hits, res.source),
        });
      }

      case "await_terminal": {
        return fail(
          call,
          "await_terminal requires native terminal bridge (run via agent loop with vscode tools)"
        );
      }

      default:
        return fail(call, `unknown tool: ${call.name}`);
    }
  } catch (e: any) {
    return fail(call, String(e?.message || e));
  }
}

function IGNORE_NAME(name: string): boolean {
  return (
    name.startsWith(".") ||
    name === "node_modules" ||
    name === "out" ||
    name === "dist" ||
    name === ".git"
  );
}
