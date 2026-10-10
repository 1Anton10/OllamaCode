import * as vscode from "vscode";
import { loadConfig } from "../config";
import { executeTool } from "./executor";
import { ToolCall } from "./parser";
import { normalizeShellCommand } from "./aiTerminal";
import { NATIVE_RUN_TERMINAL } from "./nativeTerminalBridge";
import {
  bindWindowsDesktopContext,
  runWindowsDesktop,
  setWindowsDesktopAutoApprove,
  WindowsDesktopInput,
} from "./windowsDesktop";

type WriteInput = { path?: string; content?: string };
type ReplaceInput = { path?: string; old_string?: string; new_string?: string };
type ExecInput = { command?: string; new_tab?: boolean };
type DeleteInput = { path?: string };
type WebSearchInput = { query?: string; search_term?: string; max_results?: number };

function asCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `lm_${name}_${Date.now().toString(36)}`,
    name,
    arguments: args,
    source: "openai",
    raw: JSON.stringify({ name, arguments: args }),
  };
}

function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

/** Tools registered for native chat confirmation (Allow / Always Allow / Skip). */
export function registerOllamaLmTools(context: vscode.ExtensionContext): void {
  bindWindowsDesktopContext(context);
  const writeTool: vscode.LanguageModelTool<WriteInput> = {
    async prepareInvocation(options) {
      const p = String(options.input?.path || "");
      const cfg = loadConfig();
      if (cfg.tools.autoApproveWrite) {
        return { invocationMessage: `Writing ${p || "file"}` };
      }
      return {
        invocationMessage: `Writing ${p || "file"}`,
        confirmationMessages: {
          title: "Write file",
          message: new vscode.MarkdownString(
            p ? `Allow OllamaCode to write \`${p.replace(/\\/g, "/")}\`?` : "Allow OllamaCode to write a file?"
          ),
          ...({ allowAutoConfirm: true } as object),
        },
      };
    },
    async invoke(options, _token) {
      const cfg = loadConfig();
      const result = await executeTool(asCall("write_to_file", options.input || {}), cfg, {
        skipConfirm: true,
      });
      return textResult(result.output);
    },
  };

  const replaceTool: vscode.LanguageModelTool<ReplaceInput> = {
    async prepareInvocation(options) {
      const p = String(options.input?.path || "");
      const cfg = loadConfig();
      if (cfg.tools.autoApproveWrite) {
        return { invocationMessage: `Editing ${p || "file"}` };
      }
      return {
        invocationMessage: `Editing ${p || "file"}`,
        confirmationMessages: {
          title: "Edit file",
          message: new vscode.MarkdownString(
            p ? `Allow OllamaCode to edit \`${p.replace(/\\/g, "/")}\`?` : "Allow OllamaCode to edit a file?"
          ),
          ...({ allowAutoConfirm: true } as object),
        },
      };
    },
    async invoke(options, _token) {
      const cfg = loadConfig();
      const result = await executeTool(asCall("replace_in_file", options.input || {}), cfg, {
        skipConfirm: true,
      });
      return textResult(result.output);
    },
  };

  // Alias kept for models that emit execute_command — runtime remaps to run_in_terminal
  const execTool: vscode.LanguageModelTool<ExecInput> = {
    async prepareInvocation(options) {
      const cmd = String(options.input?.command || "");
      const cfg = loadConfig();
      if (cfg.tools.autoApproveTerminal) {
        return { invocationMessage: `Running command` };
      }
      return {
        invocationMessage: `Running command`,
        confirmationMessages: {
          title: "Run command",
          message: new vscode.MarkdownString(
            cmd
              ? `Allow OllamaCode to run:\n\`\`\`\n${cmd.slice(0, 500)}\n\`\`\``
              : "Allow OllamaCode to run a command?"
          ),
          ...({ allowAutoConfirm: true } as object),
        },
      };
    },
    async invoke(options, _token) {
      const cfg = loadConfig();
      const result = await executeTool(asCall("execute_command", options.input || {}), cfg, {
        skipConfirm: true,
      });
      return textResult(result.output);
    },
  };

  const desktopTool: vscode.LanguageModelTool<WindowsDesktopInput> = {
    async prepareInvocation(options) {
      const action = String(options.input?.action || "");
      const detail = [
        action,
        options.input?.target,
        options.input?.title,
        options.input?.text,
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        invocationMessage: `Windows UI: ${action || "action"}`,
        confirmationMessages: {
          title: "Control Windows desktop?",
          message: new vscode.MarkdownString(
            `Allow OllamaCode to control the desktop UI?\n\n\`${detail.slice(0, 300) || action}\`\n\n` +
              `Focus apps, read UI as text (ui_tree), click/type. Screenshot is file-only — text models cannot see PNG.`
          ),
          ...({ allowAutoConfirm: true } as object),
        },
      };
    },
    async invoke(options, _token) {
      setWindowsDesktopAutoApprove(true);
      const out = await runWindowsDesktop(options.input || {}, context);
      return textResult(out);
    },
  };

  const deleteTool: vscode.LanguageModelTool<DeleteInput> = {
    async prepareInvocation(options) {
      const p = String(options.input?.path || "");
      const cfg = loadConfig();
      if (cfg.tools.autoApproveWrite) {
        return { invocationMessage: `Deleting ${p || "file"}` };
      }
      return {
        invocationMessage: `Deleting ${p || "file"}`,
        confirmationMessages: {
          title: "Delete file",
          message: new vscode.MarkdownString(
            p ? `Allow OllamaCode to delete \`${p.replace(/\\/g, "/")}\`?` : "Allow OllamaCode to delete a file?"
          ),
          ...({ allowAutoConfirm: true } as object),
        },
      };
    },
    async invoke(options, _token) {
      const cfg = loadConfig();
      const result = await executeTool(asCall("delete_file", options.input || {}), cfg, {
        skipConfirm: true,
      });
      return textResult(result.output);
    },
  };

  const webSearchTool: vscode.LanguageModelTool<WebSearchInput> = {
    async prepareInvocation(options) {
      const q = String(options.input?.query || options.input?.search_term || "");
      return {
        invocationMessage: `Web search: ${q.slice(0, 80) || "…"}`,
      };
    },
    async invoke(options, _token) {
      const cfg = loadConfig();
      const result = await executeTool(asCall("web_search", options.input || {}), cfg, {
        skipConfirm: true,
      });
      return textResult(result.output);
    },
  };

  context.subscriptions.push(
    vscode.lm.registerTool("write_to_file", writeTool),
    vscode.lm.registerTool("replace_in_file", replaceTool),
    vscode.lm.registerTool("execute_command", execTool),
    vscode.lm.registerTool("windows_desktop", desktopTool),
    vscode.lm.registerTool("delete_file", deleteTool),
    vscode.lm.registerTool("web_search", webSearchTool)
  );
}

export const NATIVE_CONFIRM_TOOLS = new Set(["write_to_file", "replace_in_file", "delete_file"]);

/** Force local executor (our confirm + full TOOL_RESULT in history). */
export const LOCAL_CONFIRM_TOOLS = new Set<string>(["windows_desktop", "web_search", "delete_file"]);

export const SHELL_TOOL_ALIASES =
  /^(execute_command|run_in_terminal|runCommands|run_command|run_in_terminal_cmd|shell|shell_command|execute|bash|pwsh|cmd)$/i;

/**
 * Map shell aliases → native run_in_terminal (keeps id contract for companions).
 */
export function remapToNativeTerminal(
  name: string,
  args: Record<string, unknown>
): { name: string; arguments: Record<string, unknown> } | null {
  if (!SHELL_TOOL_ALIASES.test(name)) return null;
  const raw = String(
    args.command ?? args.cmd ?? args.script ?? args.code ?? args.input ?? ""
  ).trim();
  if (!raw) return null;
  const command = normalizeShellCommand(raw);
  return {
    name: NATIVE_RUN_TERMINAL,
    arguments: {
      command,
      explanation: String(args.explanation || args.goal || "Run command in integrated terminal"),
      goal: String(args.goal || args.explanation || "Run command"),
      isBackground: Boolean(args.isBackground ?? false),
      ...(args.mode ? { mode: args.mode } : {}),
      ...(typeof args.timeout === "number" ? { timeout: args.timeout } : {}),
    },
  };
}

export function remapToExecuteCommand(
  name: string,
  args: Record<string, unknown>
): { name: string; arguments: Record<string, unknown> } | null {
  return remapToNativeTerminal(name, args);
}
