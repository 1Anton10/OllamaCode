import * as vscode from "vscode";
import { ToolCall } from "./parser";
import { formatToolResult, FormattedToolResult } from "./format";
import { TOOL_DEFINITIONS } from "./parser";

export type VscodeToolBridge = {
  /** Ollama-format function definitions for enabled VS Code tools */
  definitions: unknown[];
  /** Names that must be executed via lm.invokeTool */
  names: Set<string>;
  toolInvocationToken: vscode.ChatParticipantToolToken;
  /** How many Configure Tools / lm.tools entries were enabled */
  enabledCount: number;
  /** Tools the user attached via + / #tool — prefer these */
  attachedToolNames: string[];
  /**
   * Built-in chat `runSubagent` is available. We hide the raw tool from the model
   * and drive it through our `run_subagent` wrapper (wait / background / await).
   */
  hasNativeSubagent: boolean;
};

function toOllamaDef(tool: {
  name: string;
  description?: string;
  inputSchema?: object;
}): unknown {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || tool.name,
      parameters: tool.inputSchema || { type: "object", properties: {} },
    },
  };
}

function toolNameFromDef(def: unknown): string {
  const d = def as { function?: { name?: string } };
  return d?.function?.name || "";
}

function findLmTool(name: string): vscode.LanguageModelToolInformation | undefined {
  const tools = vscode.lm.tools || [];
  return (
    tools.find((t) => t.name === name) ||
    tools.find((t) => t.name.toLowerCase() === name.toLowerCase())
  );
}

/**
 * Collect tools for any Ollama model:
 * 1) Enabled tools from Configure Tools (request.tools map)
 * 2) Tools attached via + / #tool (toolReferences) — always included
 * 3) Fallback: all vscode.lm.tools when map empty
 * 4) Plus OllamaCode local helpers that don't collide by name
 */
export function collectVscodeTools(request: vscode.ChatRequest): VscodeToolBridge {
  const token = request.toolInvocationToken;
  const byName = new Map<string, vscode.LanguageModelToolInformation>();

  const map = (request as { tools?: Map<vscode.LanguageModelToolInformation, boolean> }).tools;
  if (map && map.size > 0) {
    for (const [tool, on] of map) {
      if (on && tool?.name) byName.set(tool.name, tool);
    }
  } else {
    // Do NOT dump every vscode.lm.tools entry — that alone can exceed 8k num_ctx.
    // Curated essentials + local TOOL_DEFINITIONS (below) are enough for Agent.
    const essential =
      /^(run_in_terminal|get_terminal_output|await_terminal|send_to_terminal|kill_terminal|create_directory|create_file|edit_files|read_file|list_dir|grep_search|file_search|runSubagent|apply_patch|replace_string_in_file)$/i;
    for (const tool of vscode.lm.tools || []) {
      if (tool?.name && essential.test(tool.name)) byName.set(tool.name, tool);
    }
  }

  // Paperclip / #tool attachments must be visible even if unchecked in Configure Tools
  const attachedToolNames: string[] = [];
  for (const tr of request.toolReferences || []) {
    if (!tr?.name) continue;
    attachedToolNames.push(tr.name);
    if (!byName.has(tr.name)) {
      const found = findLmTool(tr.name);
      if (found) byName.set(found.name, found);
      else {
        // Stub schema so the model can still emit a call; invokeTool may resolve by name
        byName.set(tr.name, {
          name: tr.name,
          description: `User-attached tool: ${tr.name}`,
          inputSchema: { type: "object", properties: {} },
          tags: [],
        } as vscode.LanguageModelToolInformation);
      }
    }
  }

  // Keep native run_in_terminal + companions (get_terminal_output, …).
  // Drop only shell aliases that collide; runtime remaps them → run_in_terminal.
  const shellAliases =
    /^(execute_command|runCommands|run_command|run_in_terminal_cmd|shell|shell_command|bash|pwsh|cmd)$/i;
  const rit = findLmTool("run_in_terminal");
  if (rit) byName.set(rit.name, rit);

  // Always surface native browser + fetch tools when registered (never reimplement them).
  const nativeBrowserOrFetch =
    /^(open_browser_page|openBrowserPage|readPage|navigatePage|clickElement|typeInPage|hoverElement|dragElement|handleDialog|screenshotPage|runPlaywrightCode|listBrowserPages|vscode_fetchWebPage_internal|fetch_webpage|fetchWebPage)$/i;
  for (const tool of vscode.lm.tools || []) {
    if (!tool?.name) continue;
    if (nativeBrowserOrFetch.test(tool.name) || /fetchWebPage|fetch_webpage/i.test(tool.name)) {
      byName.set(tool.name, tool);
    }
  }

  // Native Built-In runSubagent = nested copy of the default agent (UI «Summoning Clippy»).
  // Keep it visible so the model can call it like before; also keep our run_subagent pool.
  const nativeSub =
    findLmTool("runSubagent") ||
    byName.get("runSubagent") ||
    [...byName.values()].find((t) => /^runSubagent$/i.test(t.name));
  const hasNativeSubagent = Boolean(nativeSub);
  if (nativeSub && !byName.has(nativeSub.name)) {
    byName.set(nativeSub.name, nativeSub);
  }

  for (const n of [...byName.keys()]) {
    if (shellAliases.test(n)) byName.delete(n);
  }

  const enabled = [...byName.values()];
  const names = new Set(enabled.map((t) => t.name));
  if (hasNativeSubagent) names.add("runSubagent");

  // All enabled names stay invokable; only a curated subset gets FULL schemas in the
  // prompt. Dumping 35 Configure-Tools schemas eats the window and the model "forgets"
  // run_subagent (only notices list_subagents from a truncated view).
  const SCHEMA_IN_PROMPT =
    /^(run_in_terminal|get_terminal_output|await_terminal|send_to_terminal|kill_terminal|create_directory|create_file|edit_files|read_file|list_dir|grep_search|file_search|apply_patch|replace_string_in_file|open_browser_page|openBrowserPage|readPage|navigatePage|fetch_webpage|fetchWebPage|vscode_fetchWebPage_internal)$/i;
  const attached = new Set(attachedToolNames);
  const showAllSchemas = enabled.length <= 18;
  // Do NOT expose raw Built-In runSubagent — hangs on «Summoning Clippy». Use run_subagent.
  const vscodeDefs = enabled
    .filter((t) => !/^runSubagent$/i.test(t.name))
    .filter(
      (t) =>
        showAllSchemas || SCHEMA_IN_PROMPT.test(t.name) || attached.has(t.name)
    )
    .map((t) => toOllamaDef(t));

  const extras = TOOL_DEFINITIONS.filter((d) => {
    const n = toolNameFromDef(d);
    // Prefer native run_in_terminal over our execute_command schema when available
    if (names.has("run_in_terminal") && n === "execute_command") return false;
    // Always keep our pool tools even if a colliding name exists
    if (
      /^(run_subagent|await_subagent|list_subagents|move_chat_workspace|open_workspace|create_project_workspace)$/i.test(
        n
      )
    )
      return true;
    return n && !names.has(n) && !enabled.some((t) => t.name === n);
  });
  // Pool / local tools first (run_subagent + workspace before fat Built-Ins)
  const poolFirst =
    /^(run_subagent|await_subagent|list_subagents|move_chat_workspace|open_workspace|create_project_workspace)$/i;
  const head = extras.filter((d) => poolFirst.test(toolNameFromDef(d)));
  const restExtras = extras.filter((d) => !poolFirst.test(toolNameFromDef(d)));
  const defs = [...head, ...restExtras, ...vscodeDefs];

  return {
    definitions: defs,
    names,
    toolInvocationToken: token,
    enabledCount: enabled.length,
    attachedToolNames,
    hasNativeSubagent,
  };
}

function bridgeHas(bridge: VscodeToolBridge, re: RegExp): boolean {
  for (const n of bridge.names) {
    if (re.test(n)) return true;
  }
  return false;
}

/** Extra system rules so the model knows attached tools / attachments exist. */
export function toolsAwarenessRules(bridge: VscodeToolBridge): string {
  const lines = [
    "Вызывай tools через native tool_calls. Не выдумывай результаты.",
    "Контекст: (1) физический KV = num_ctx — токены в окне Ollama сейчас; (2) VCTX = виртуальная память на диске (чип 32k/128k), упаковщик архивирует старые ходы ~с 80% окна. В user часто уже есть [REPO_MAP] — читай его. Архив → vctx_index, потом vctx_recall. Не проси раздувать num_ctx. Обзор: один list/map + ответ. Аудит «проверь все tools» — пройди широкий набор (в т.ч. пустые/ошибочные), не останавливайся после 3–5 OK.",
    "GUI Windows: windows_desktop. NO vision. Recipe: snapshot(process=Telegram)->match.hwnd->focus->ui_tree(focus=false)->click/type. Titles are chat names - filter by process. Never close/Alt+F4. Console start != E2E.",
    "Терминал (долгий): run_in_terminal background → terminal_id → await_terminal(id, pattern, timeout_ms≤20мин). Нет match → ещё ждать / другой pattern / вывод: дальше ничего не будет. kill только сбой/рестарт/просьба.",
    "Сеть: web_search для поиска; URL содержимое — нативный fetch/browser (не выдумывай страницы). delete_file — удаление файла.",
  ];
  if (bridgeHas(bridge, /^open_browser_page$/i) || bridgeHas(bridge, /^openBrowserPage$/i)) {
    lines.push(
      "Браузер (нативный Integrated Browser): open_browser_page → page id → readPage/navigatePage/clickElement/typeInPage/…. Не клонируй browser tools и не выдумывай DOM."
    );
  }
  if (
    bridgeHas(bridge, /fetchWebPage|fetch_webpage|vscode_fetchWebPage/i)
  ) {
    lines.push(
      "Fetch страницы: используй нативный vscode_fetchWebPage_internal / fetch_webpage (urls[]). Не подменяй своим HTTP."
    );
  }
  lines.push(
    "CORE_TOOLS: run_subagent, await_subagent, await_terminal, run_in_terminal, read_file, write_to_file, move_chat_workspace, open_workspace, create_project_workspace, list_files, grep, repo_map, vctx_*."
  );
  lines.push(
    "Сабагент: run_subagent(goal, wait?). wait=true = плашка Summoning; wait=false = фон → await_subagent. Другая папка + этот же чат → move_chat_workspace(path) (in-place, окно НЕ переоткрывается). Только сменить папку → open_workspace. Не ставь reload=true."
  );
  if (bridge.attachedToolNames.length) {
    lines.push(`Прикреплены: ${bridge.attachedToolNames.join(", ")}.`);
  }
  return lines.join("\n");
}

/** Run the Built-In chat runSubagent tool with a detailed prompt. */
export async function invokeNativeRunSubagent(
  bridge: VscodeToolBridge,
  goal: string,
  mode: "read" | "implement",
  token?: vscode.CancellationToken,
  timeoutMs = 45_000
): Promise<FormattedToolResult> {
  const prompt =
    mode === "implement"
      ? `${goal}\n\nYou may edit files. Return a concise report: what changed, paths, outcome, leftover risks.`
      : `${goal}\n\nResearch only — do not edit files. Return findings, key paths, and what the parent should do next.`;
  const description =
    goal.replace(/\s+/g, " ").trim().slice(0, 60) || (mode === "implement" ? "implement task" : "research task");
  const call = {
    id: `native_sub_${Date.now().toString(36)}`,
    name: "runSubagent",
    arguments: { prompt, description },
    source: "openai" as const,
    raw: "",
  };
  try {
    return await Promise.race([
      invokeVscodeTool(call, bridge, token),
      new Promise<FormattedToolResult>((_, reject) => {
        setTimeout(
          () => reject(new Error(`native runSubagent timeout ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } catch (e: any) {
    return formatToolResult({
      call,
      status: "FAILED",
      summary: `vscode:runSubagent failed: ${e?.message || e}`,
      detail: String(e?.message || e),
      action: "OTHER",
    });
  }
}

function partsToText(result: vscode.LanguageModelToolResult): string {
  const parts: string[] = [];
  for (const part of result.content || []) {
    const anyPart = part as { value?: unknown; text?: unknown };
    // Duck-type: `instanceof LanguageModelTextPart` fails across extension realms
    // and was returning empty → agent saw no windows_desktop output.
    if (typeof anyPart?.value === "string") {
      parts.push(anyPart.value);
    } else if (typeof anyPart?.text === "string") {
      parts.push(anyPart.text);
    } else if (part instanceof vscode.LanguageModelTextPart) {
      parts.push(part.value);
    } else {
      try {
        parts.push(JSON.stringify(part));
      } catch {
        parts.push(String(part));
      }
    }
  }
  return parts.join("\n").trim();
}

/** Invoke a VS Code Built-In / extension tool and wrap as TOOL_RESULT. */
export async function invokeVscodeTool(
  call: ToolCall,
  bridge: VscodeToolBridge,
  token?: vscode.CancellationToken
): Promise<FormattedToolResult> {
  try {
    const result = await vscode.lm.invokeTool(
      call.name,
      {
        input: call.arguments || {},
        toolInvocationToken: bridge.toolInvocationToken,
      },
      token
    );
    const detail = partsToText(result) || "(empty tool result)";
    const failed = /\bstatus:\s*FAILED\b/i.test(detail) || detail === "(empty tool result)";
    return formatToolResult({
      call,
      status: failed ? "FAILED" : "OK",
      summary: failed ? `vscode:${call.name} failed` : `vscode:${call.name}`,
      detail,
      action: "OTHER",
    });
  } catch (e: any) {
    return formatToolResult({
      call,
      status: "FAILED",
      summary: `vscode tool failed: ${e?.message || e}`,
      detail: String(e?.stack || e?.message || e),
    });
  }
}
