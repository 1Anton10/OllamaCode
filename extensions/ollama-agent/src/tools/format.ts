import { ToolCall } from "./parser";

export type ToolStatus = "OK" | "FAILED" | "RUNNING" | "DENIED" | "BLOCKED";
export type ToolAction = "CREATED" | "UPDATED" | "UNCHANGED" | "READ" | "RAN" | "SEARCHED" | "OTHER";

export type FileTreeEntry = {
  name: string;
  dir: boolean;
  /** One-level children so chat filetree expanders open real content */
  children?: FileTreeEntry[];
};

export type ToolResultUi =
  | { kind: "filetree"; path: string; entries: FileTreeEntry[]; truncated?: number }
  | { kind: "read"; path: string }
  | { kind: "edit"; path: string; before: string; after: string };

export interface FormattedToolResult {
  call: ToolCall;
  ok: boolean;
  status: ToolStatus;
  path?: string;
  action?: ToolAction;
  summary: string;
  detail: string;
  hint?: string;
  exitCode?: number;
  /** Rich chat UI (filetree / diff card) */
  ui?: ToolResultUi;
  /** Machine + human readable block for the model */
  output: string;
}

export function formatToolResult(opts: {
  call: ToolCall;
  status: ToolStatus;
  summary: string;
  detail?: string;
  path?: string;
  action?: ToolAction;
  hint?: string;
  exitCode?: number;
  ui?: ToolResultUi;
}): FormattedToolResult {
  // Cap detail — keep large dumps usable on long projects (VCTX archives the rest).
  const detail = (opts.detail || "").slice(0, 48_000);
  const lines = [
    "[TOOL_RESULT]",
    `tool: ${opts.call.name}`,
    `status: ${opts.status}`,
  ];
  if (opts.path) lines.push(`path: ${opts.path}`);
  if (opts.action) lines.push(`action: ${opts.action}`);
  if (opts.exitCode !== undefined) lines.push(`exit: ${opts.exitCode}`);
  lines.push(`summary: ${opts.summary}`);
  if (detail) lines.push(`detail:\n${detail}`);
  if (opts.hint) lines.push(`hint: ${opts.hint}`);
  if (opts.status === "FAILED") {
    lines.push(
      "hint: если FAILED — не повторяй ту же команду без изменения; прочитай ошибку и исправь подход"
    );
  }
  if (opts.status === "BLOCKED") {
    lines.push(
      "hint: BLOCKED = петля (FAILED с теми же args, или 3× подряд identical). После успешной правки файла read_file снова можно. Смени подход по ошибке из TOOL_RESULT или дай итог."
    );
  }
  lines.push("[/TOOL_RESULT]");
  const output = lines.join("\n");
  return {
    call: opts.call,
    ok: opts.status === "OK" || opts.status === "RUNNING",
    status: opts.status,
    path: opts.path,
    action: opts.action,
    summary: opts.summary,
    detail,
    hint: opts.hint,
    exitCode: opts.exitCode,
    ui: opts.ui,
    output,
  };
}
