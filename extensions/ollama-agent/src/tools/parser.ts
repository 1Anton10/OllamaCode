export type ToolName =
  | "execute_command"
  | "read_file"
  | "write_to_file"
  | "replace_in_file"
  | "delete_file"
  | "list_files"
  | "search_files"
  | "grep"
  | "get_diagnostics"
  | "open_file"
  | "repo_map"
  | "run_subagent"
  | "await_subagent"
  | "list_subagents"
  | "update_task"
  | "ask_followup_question"
  | "open_workspace"
  | "create_project_workspace"
  | "fork_project_workspace"
  | "move_chat_workspace"
  | "vctx_recall"
  | "vctx_index"
  | "windows_desktop"
  | "web_search"
  | "await_terminal";

export interface ToolCall {
  id: string;
  name: ToolName | string;
  arguments: Record<string, any>;
  source: "json" | "xml" | "openai";
  raw: string;
}

function genId() {
  return `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseJsonTools(text: string): ToolCall[] {
  const out: ToolCall[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) {
    const obj = safeJsonParse(m[1].trim());
    collectJsonObj(obj, m[0], out);
  }
  // Qwen / Llama / Hermes-style wrappers
  const wrapped =
    /<(?:tool_call|function_call|tool)\s*>\s*([\s\S]*?)<\/(?:tool_call|function_call|tool)>/gi;
  while ((m = wrapped.exec(text))) {
    const inner = m[1].trim();
    const obj = safeJsonParse(inner);
    if (obj) collectJsonObj(obj, m[0], out);
    else {
      const nameM = /"name"\s*:\s*"([^"]+)"/.exec(inner);
      const argsM = /"arguments"\s*:\s*(\{[\s\S]*\})/.exec(inner);
      if (nameM) {
        out.push({
          id: genId(),
          name: nameM[1],
          arguments: (argsM && safeJsonParse(argsM[1])) || {},
          source: "json",
          raw: m[0],
        });
      }
    }
  }
  const bare =
    /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  while ((m = bare.exec(text))) {
    const args = safeJsonParse(m[2]) || {};
    out.push({
      id: genId(),
      name: m[1],
      arguments: args,
      source: "json",
      raw: m[0],
    });
  }
  // {"function":"write_to_file","parameters":{...}} alternate shape
  const alt =
    /\{\s*"function"\s*:\s*"([^"]+)"\s*,\s*"(?:parameters|arguments)"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  while ((m = alt.exec(text))) {
    const args = safeJsonParse(m[2]) || {};
    out.push({
      id: genId(),
      name: m[1],
      arguments: args,
      source: "json",
      raw: m[0],
    });
  }
  const toolCallsBlock = /"tool_calls"\s*:\s*(\[[\s\S]*?\])/g;
  while ((m = toolCallsBlock.exec(text))) {
    const arr = safeJsonParse(m[1]);
    if (Array.isArray(arr)) {
      for (const tc of arr) {
        const name = tc?.function?.name || tc?.name;
        let args = tc?.function?.arguments ?? tc?.arguments ?? {};
        if (typeof args === "string") args = safeJsonParse(args) || { raw: args };
        if (name) {
          out.push({
            id: tc.id || genId(),
            name,
            arguments: args,
            source: "openai",
            raw: JSON.stringify(tc),
          });
        }
      }
    }
  }
  return out;
}

function collectJsonObj(obj: any, raw: string, out: ToolCall[]) {
  if (!obj) return;
  if (Array.isArray(obj)) {
    for (const x of obj) collectJsonObj(x, raw, out);
    return;
  }
  if (obj.name && (obj.arguments || obj.parameters || obj.args)) {
    out.push({
      id: genId(),
      name: obj.name,
      arguments: obj.arguments || obj.parameters || obj.args || {},
      source: "json",
      raw,
    });
  }
  if (Array.isArray(obj.tool_calls)) {
    collectJsonObj(obj.tool_calls, raw, out);
  }
}

function xmlText(tag: string, block: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  return m ? m[1].trim() : undefined;
}

const XML_TOOLS: Array<{ name: ToolName; args: (b: string) => Record<string, any> }> = [
  {
    name: "execute_command",
    args: (b) => ({
      command: xmlText("command", b) || b.replace(/<\/?execute_command>/gi, "").trim(),
    }),
  },
  { name: "read_file", args: (b) => ({ path: xmlText("path", b) || "", offset: xmlText("offset", b), limit: xmlText("limit", b) }) },
  {
    name: "write_to_file",
    args: (b) => ({ path: xmlText("path", b) || "", content: xmlText("content", b) || "" }),
  },
  {
    name: "replace_in_file",
    args: (b) => ({
      path: xmlText("path", b) || "",
      old_string: xmlText("old_string", b) || "",
      new_string: xmlText("new_string", b) || "",
    }),
  },
  { name: "delete_file", args: (b) => ({ path: xmlText("path", b) || "" }) },
  { name: "list_files", args: (b) => ({ path: xmlText("path", b) || "." }) },
  {
    name: "search_files",
    args: (b) => ({
      path: xmlText("path", b) || ".",
      regex: xmlText("regex", b) || xmlText("query", b) || "",
    }),
  },
  {
    name: "grep",
    args: (b) => ({
      query: xmlText("query", b) || xmlText("pattern", b) || "",
      is_regex: true,
    }),
  },
  { name: "get_diagnostics", args: (b) => ({ path: xmlText("path", b) || "" }) },
  { name: "open_file", args: (b) => ({ path: xmlText("path", b) || "" }) },
  { name: "repo_map", args: (b) => ({ max_chars: xmlText("max_chars", b) || "3000" }) },
  {
    name: "open_workspace",
    args: (b) => ({
      path: xmlText("path", b) || xmlText("folder", b) || "",
      new_window: xmlText("new_window", b) === "true",
    }),
  },
  {
    name: "create_project_workspace",
    args: (b) => ({
      path: xmlText("path", b) || xmlText("folder", b) || "",
      new_window: xmlText("new_window", b) !== "false",
    }),
  },
  {
    name: "fork_project_workspace",
    args: (b) => ({
      path: xmlText("path", b) || xmlText("folder", b) || "",
      new_window: xmlText("new_window", b) !== "false",
      keep_git: xmlText("keep_git", b) !== "false",
    }),
  },
  {
    name: "move_chat_workspace",
    args: (b) => ({
      path: xmlText("path", b) || xmlText("folder", b) || "",
      create: xmlText("create", b) === "true",
      new_window: xmlText("new_window", b) === "true",
      reload: xmlText("reload", b) === "true" || xmlText("hard", b) === "true",
    }),
  },
  {
    name: "run_subagent",
    args: (b) => ({
      goal: xmlText("goal", b) || xmlText("prompt", b) || "",
      mode: xmlText("mode", b) || "read",
      wait: xmlText("wait", b),
    }),
  },
  {
    name: "await_subagent",
    args: (b) => ({
      id: xmlText("id", b) || xmlText("job_id", b) || "",
      timeout_ms: xmlText("timeout_ms", b),
    }),
  },
  {
    name: "list_subagents",
    args: () => ({}),
  },
  {
    name: "update_task",
    args: (b) => ({
      id: xmlText("id", b),
      title: xmlText("title", b) || "",
      status: xmlText("status", b) || "pending",
      note: xmlText("note", b),
    }),
  },
  {
    name: "ask_followup_question",
    args: (b) => ({ question: xmlText("question", b) || b }),
  },
  {
    name: "vctx_recall",
    args: (b) => ({
      query: xmlText("query", b) || xmlText("q", b) || "",
      ids: xmlText("ids", b) || "",
      max_items: xmlText("max_items", b),
      max_chars: xmlText("max_chars", b),
    }),
  },
  {
    name: "vctx_index",
    args: (b) => ({
      limit: xmlText("limit", b) || "40",
    }),
  },
  {
    name: "web_search",
    args: (b) => ({
      query: xmlText("query", b) || xmlText("search_term", b) || "",
      max_results: xmlText("max_results", b),
    }),
  },
  {
    name: "await_terminal",
    args: (b) => ({
      id: xmlText("id", b) || xmlText("terminal_id", b) || "",
      pattern: xmlText("pattern", b) || "",
      timeout_ms: xmlText("timeout_ms", b),
    }),
  },
];

function parseXmlTools(text: string): ToolCall[] {
  const out: ToolCall[] = [];
  for (const t of XML_TOOLS) {
    const re = new RegExp(`<${t.name}>([\\s\\S]*?)</${t.name}>`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({
        id: genId(),
        name: t.name,
        arguments: t.args(m[0]),
        source: "xml",
        raw: m[0],
      });
    }
  }
  return out;
}

/**
 * Qwen 3.x text protocol (when native tool_calls missing):
 * <tool_call>
 * <function=grep>
 * <parameter=path>...</parameter>
 * <parameter=pattern>...</parameter>
 * </function>
 * </tool_call>
 */
function parseQwenFunctionXml(text: string): ToolCall[] {
  const out: ToolCall[] = [];
  const pushFn = (name: string, body: string, raw: string) => {
    const n = (name || "").trim();
    if (!n) return;
    const args: Record<string, unknown> = {};
    const pRe = /<parameter=([^>\s/]+)\s*>([\s\S]*?)<\/parameter>/gi;
    let pm: RegExpExecArray | null;
    while ((pm = pRe.exec(body))) {
      args[pm[1].trim()] = pm[2].trim();
    }
    out.push({
      id: genId(),
      name: n,
      arguments: args,
      source: "xml",
      raw,
    });
  };

  const blockRe = /<tool_call>\s*([\s\S]*?)<\/tool_call>/gi;
  let bm: RegExpExecArray | null;
  let matchedBlocks = false;
  while ((bm = blockRe.exec(text))) {
    matchedBlocks = true;
    const fnRe = /<function=([^>\s/]+)\s*>([\s\S]*?)<\/function>/gi;
    let fm: RegExpExecArray | null;
    while ((fm = fnRe.exec(bm[1]))) {
      pushFn(fm[1], fm[2], bm[0]);
    }
  }
  if (!matchedBlocks) {
    // Bare <function=…> without wrapper (partial streams / some templates)
    const fnRe = /<function=([^>\s/]+)\s*>([\s\S]*?)<\/function>/gi;
    let fm: RegExpExecArray | null;
    while ((fm = fnRe.exec(text))) {
      pushFn(fm[1], fm[2], fm[0]);
    }
  }
  return out;
}

export function parseToolCalls(
  text: string,
  opts: { allowJson: boolean; allowXml: boolean }
): ToolCall[] {
  const calls: ToolCall[] = [];
  if (opts.allowJson) calls.push(...parseJsonTools(text));
  if (opts.allowXml) {
    calls.push(...parseXmlTools(text));
    calls.push(...parseQwenFunctionXml(text));
  }
  const seen = new Set<string>();
  return calls.filter((c) => {
    const key = `${c.name}:${JSON.stringify(c.arguments)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Qwen often dumps &lt;tool_call&gt; into the thinking channel, not content.
 * Merge both surfaces so the agent actually executes instead of dying on raw XML.
 */
export function parseToolCallsFromTurn(
  assistantText: string,
  thinkingText: string,
  opts: { allowJson: boolean; allowXml: boolean }
): ToolCall[] {
  const a = String(assistantText || "");
  const t = String(thinkingText || "");
  if (!t.trim()) return parseToolCalls(a, opts);
  if (!a.trim()) return parseToolCalls(t, opts);
  return parseToolCalls(`${a}\n${t}`, opts);
}

/** Stream ended mid-tool markup — must continue, not accept as final answer. */
export function hasIncompleteToolMarkup(text: string): boolean {
  const s = String(text || "");
  if (!s) return false;
  const openTc = (s.match(/<tool_call>/gi) || []).length;
  const closeTc = (s.match(/<\/tool_call>/gi) || []).length;
  if (openTc > closeTc) return true;
  const openFn = (s.match(/<function=/gi) || []).length;
  const closeFn = (s.match(/<\/function>/gi) || []).length;
  if (openFn > closeFn) return true;
  if (/<(?:tool_call|function)=?[^>]*>\s*$/i.test(s.trim())) return true;
  return false;
}

const XML_TAG_RE = XML_TOOLS.map((t) => t.name).join("|");

/**
 * Remove tool XML/JSON from text. Default trims (final answers).
 * Streaming deltas MUST use trim=false — otherwise a lone " " is dropped and
 * words glue: «Пользовательпросит» / «Theuserwants».
 */
export function stripToolMarkup(text: string, opts?: { trim?: boolean }): string {
  let t = text;
  if (!t) return t;
  // Preserve whitespace-only chunks unchanged (streamed spaces/newlines)
  if (/^\s+$/.test(t)) return t;
  t = t.replace(/```json\s*[\s\S]*?```/gi, "");
  t = t.replace(/<(?:tool_call|function_call|tool)\s*>[\s\S]*?<\/(?:tool_call|function_call|tool)>/gi, "");
  t = t.replace(/<function=[^>\s/]+[\s\S]*?<\/function>/gi, "");
  t = t.replace(new RegExp(`<(${XML_TAG_RE})>[\\s\\S]*?<\\/\\1>`, "gi"), "");
  t = t.replace(/\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g, "");
  t = t.replace(/\{\s*"function"\s*:\s*"[^"]+"\s*,\s*"(?:parameters|arguments)"\s*:\s*\{[\s\S]*?\}\s*\}/g, "");
  return opts?.trim === false ? t : t.trim();
}

/** Core tools that must survive context trimming. */
const TOOL_KEEP_ALWAYS =
  /^(run_in_terminal|execute_command|read_file|write_to_file|replace_in_file|list_files|grep|search_files|get_diagnostics|get_terminal_output|await_terminal|send_to_terminal|kill_terminal|repo_map|ask_followup_question|vctx_recall|vctx_index|create_file|edit_files|apply_patch|replace_string_in_file|run_subagent|await_subagent|list_subagents|open_workspace|create_project_workspace|move_chat_workspace|fork_project_workspace)$/i;

function toolDefName(d: unknown): string {
  const x = d as { function?: { name?: string }; name?: string };
  return x?.function?.name || x?.name || "";
}

function toolDefTokens(d: unknown): number {
  try {
    return Math.max(1, Math.ceil(JSON.stringify(d).length / 4));
  } catch {
    return 80;
  }
}

/**
 * Fit tool schemas into physical num_ctx.
 * Full VS Code tool dumps can be 8k+ tokens alone — that caused exceed_context_size at 8192.
 */
export function trimToolsForContext(defs: unknown[], numCtx: number): unknown[] {
  if (!Array.isArray(defs) || !defs.length) return [];
  const ctx = Math.max(2048, numCtx || 8192);
  // Reserve most of the window for system+history+reply; tools get a hard budget
  const budget = Math.max(900, Math.min(4500, Math.floor(ctx * 0.28)));

  const scored = defs.map((d, i) => {
    const name = toolDefName(d);
    const keep = TOOL_KEEP_ALWAYS.test(name) ? 0 : 1;
    return { d, name, keep, tok: toolDefTokens(d), i };
  });
  scored.sort((a, b) => a.keep - b.keep || a.tok - b.tok || a.i - b.i);

  const out: unknown[] = [];
  const seen = new Set<string>();
  let used = 0;
  // Pass 1: MUST include every TOOL_KEEP_ALWAYS present (never drop run_subagent)
  for (const s of scored) {
    if (s.keep !== 0 || seen.has(s.name)) continue;
    out.push(s.d);
    seen.add(s.name);
    used += s.tok;
  }
  // Pass 2: fill remaining budget with optional tools
  for (const s of scored) {
    if (s.keep === 0 || seen.has(s.name)) continue;
    if (used + s.tok > budget && out.length >= 8) continue;
    if (used + s.tok > budget * 1.15) continue;
    out.push(s.d);
    seen.add(s.name);
    used += s.tok;
  }
  if (!out.length) return defs.slice(0, 8);
  return out;
}

function fn(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required?: string[]
) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        ...(required ? { required } : {}),
      },
    },
  };
}

export const TOOL_DEFINITIONS = [
  fn(
    "execute_command",
    "Alias of run_in_terminal. Prefer run_in_terminal. On Windows PowerShell use `;` not `&&`.",
    {
      command: { type: "string" },
      new_tab: { type: "boolean" },
    },
    ["command"]
  ),
  fn(
    "windows_desktop",
    "Windows desktop UI (TEXT only, no vision). Recipe: snapshot(process=Telegram)->match.hwnd->focus->ui_tree(focus=false)->click_element|type. NEVER close/Alt+F4 messengers. Telegram titles are chat names - use process=Telegram.",
    {
      action: {
        type: "string",
        description:
          "snapshot|list_windows|foreground|focus|minimize|maximize|close|launch|click|double_click|move|scroll|type|keys|find|click_element|set_value|ui_tree|screenshot|clipboard_get|clipboard_set|wait",
      },
      target: { type: "string", description: "launch path or URI" },
      title: { type: "string", description: "window title substring (optional; Telegram often has chat name as title)" },
      process: { type: "string", description: "process name substring e.g. Telegram (preferred filter)" },
      hwnd: { type: "number", description: "window handle from snapshot pick/match" },
      x: { type: "number" },
      y: { type: "number" },
      relative: { type: "boolean", description: "x/y relative to window" },
      button: { type: "string", description: "left|right|middle" },
      clicks: { type: "number" },
      delta: { type: "number", description: "scroll wheel delta (120 per notch)" },
      text: { type: "string", description: "text to type / clipboard / set_value" },
      keys: {
        type: "string",
        description: "SendKeys e.g. {ENTER}^a - NEVER %{F4}/Alt+F4 (blocked). Requires hwnd|title|process.",
      },
      name: { type: "string", description: "UI element Name (substring OK)" },
      automation_id: { type: "string" },
      control_type: { type: "string", description: "button|edit|menu|list|tab|check|combo|link" },
      path: { type: "string", description: "screenshot output path" },
      window_only: { type: "boolean" },
      on_screen_only: { type: "boolean", description: "filter on-screen windows (default true for snapshot)" },
      focus: { type: "boolean", description: "ui_tree: steal focus only if true (default false)" },
      max_depth: { type: "number", description: "ui_tree depth 1..6" },
      ms: { type: "number", description: "wait timeout ms" },
    },
    ["action"]
  ),
  fn("read_file", "Read a file. Short files (≤500 lines) always return in full with EOF hint — do not page with offset. Optional offset/limit only for large files.", {
    path: { type: "string" },
    offset: { type: "number", description: "Start line (0-based), large files only" },
    limit: { type: "number", description: "Max lines, large files only; omit to read all / rest" },
  }, ["path"]),
  fn("write_to_file", "Create or overwrite a file", {
    path: { type: "string" },
    content: { type: "string" },
  }, ["path", "content"]),
  fn("replace_in_file", "Replace exact old_string with new_string in a file", {
    path: { type: "string" },
    old_string: { type: "string" },
    new_string: { type: "string" },
  }, ["path", "old_string", "new_string"]),
  fn("delete_file", "Delete a file (trash when supported). Prefer over shell rm.", {
    path: { type: "string" },
  }, ["path"]),
  fn("list_files", "List files in a directory", { path: { type: "string" } }),
  fn("search_files", "Search file paths by regex", {
    path: { type: "string" },
    regex: { type: "string" },
  }, ["regex"]),
  fn("grep", "Search file contents by regex", {
    query: { type: "string" },
    max_results: { type: "number" },
  }, ["query"]),
  fn("get_diagnostics", "Get VS Code diagnostics/problems", {
    path: { type: "string" },
  }),
  fn("open_file", "Open a file in the editor", { path: { type: "string" } }, ["path"]),
  fn("repo_map", "Get workspace structure map (no embeddings)", {
    max_chars: { type: "number" },
    refresh: { type: "boolean" },
  }),
  fn(
    "open_workspace",
    "Open/switch to an existing folder in THIS window (in-place, no reload). Does not transfer chat metadata — use move_chat_workspace when continuity matters. Pass reload=true only for hard vscode.openFolder.",
    {
      path: { type: "string", description: "Absolute folder path" },
      new_window: { type: "boolean", description: "Open in a new window (default false = replace)" },
      move_chat: {
        type: "boolean",
        description: "If true, same as move_chat_workspace (transfer this chat)",
      },
    },
    ["path"]
  ),
  fn(
    "create_project_workspace",
    "Create a new empty project folder and open it (default: new window). Use for a brand-new project from the current chat.",
    {
      path: { type: "string", description: "Absolute path or name under ~/Projects" },
      new_window: {
        type: "boolean",
        description: "Prefer new window (default true)",
      },
    },
    ["path"]
  ),
  fn(
    "fork_project_workspace",
    "Copy the current workspace to a new folder (fork) and open it. Skips node_modules by default.",
    {
      path: {
        type: "string",
        description: "Destination folder (absolute or sibling name like myapp-fork)",
      },
      new_window: { type: "boolean", description: "Open fork in new window (default true)" },
      keep_git: { type: "boolean", description: "Copy .git (default true)" },
    },
    ["path"]
  ),
  fn(
    "move_chat_workspace",
    "Switch THIS chat to another folder in the SAME window (updateWorkspaceFolders + agent root — no window reload). Migrates chatSessions on disk so reload keeps the chat. Use when the user asks about a different project/path. Pass reload=true only for hard openFolder (kills in-flight turn).",
    {
      path: {
        type: "string",
        description: "Absolute folder path (or name under ~/Projects)",
      },
      create: {
        type: "boolean",
        description: "Create the folder if missing (default false)",
      },
      new_window: {
        type: "boolean",
        description: "Open in a new window (default false). Implies hard reload.",
      },
      reload: {
        type: "boolean",
        description: "Hard vscode.openFolder reload (default false). Avoid — kills in-flight chat.",
      },
    },
    ["path"]
  ),
  fn(
    "run_subagent",
    "Spawn a sub-agent. wait=true → block + VS Code native Summoning plaque when available; wait=false → background local pool (id, no plaque). mode=read defaults wait=false; mode=implement defaults wait=true. Goal must say what to RETURN. Relay the result to the user yourself.",
    {
      goal: { type: "string", description: "Detailed narrow subtask + what to return" },
      mode: { type: "string", description: "read | implement" },
      wait: {
        type: "boolean",
        description:
          "true = wait for finish (native plaque if Built-In on). false = background id. Default: false for read, true for implement.",
      },
    },
    ["goal"]
  ),
  fn(
    "await_subagent",
    "Block until a background subagent id finishes (or timeout). Use when the next step depends on its report.",
    {
      id: { type: "string" },
      timeout_ms: {
        type: "number",
        description: "Max wait ms (default 180000, max ~20min)",
      },
    },
    ["id"]
  ),
  fn("list_subagents", "List running/done subagent jobs (id, status, mode, goal)", {}),
  fn("update_task", "Create/update a task on the board", {
    id: { type: "string" },
    title: { type: "string" },
    status: { type: "string" },
    note: { type: "string" },
  }, ["title"]),
  fn(
    "vctx_recall",
    "Recall from virtual chat memory (VCTX disk slots). Returns SEPARATE fenced blocks per message — never merged mush. Use when older chat details are missing from the current window. Pass query (search) and/or ids (exact slot ids from INDEX / prior results).",
    {
      query: {
        type: "string",
        description: "What to find in archived turns (keywords / path / error text)",
      },
      ids: {
        type: "array",
        items: { type: "string" },
        description: "Exact slot ids to fetch in full",
      },
      max_items: { type: "number", description: "1–12, default 4" },
      max_chars: {
        type: "number",
        description: "Max chars per slot (default 3500). Truncated slots say so and keep id for re-fetch.",
      },
    }
  ),
  fn(
    "vctx_index",
    "List virtual context INDEX (titles/previews + slot ids only). Use before vctx_recall when you need to pick ids.",
    {
      limit: { type: "number", description: "How many recent index rows (default 40)" },
    }
  ),
  fn(
    "web_search",
    "Search the public web (titles/URLs/snippets). For page body use native fetch_webpage / browser tools — do not invent content.",
    {
      query: { type: "string", description: "Search query" },
      search_term: { type: "string", description: "Alias of query" },
      max_results: { type: "number", description: "1–10, default 5" },
    }
  ),
  fn(
    "await_terminal",
    "Long-running terminal waiter (like Cursor AwaitShell). Poll get_terminal_output until pattern matches, process exits, or timeout (default 60s, max 20min). Requires terminal_id from background run_in_terminal. If no match: decide — wait more (higher timeout_ms), change pattern, or conclude nothing more is coming.",
    {
      id: { type: "string", description: "terminal_id UUID" },
      terminal_id: { type: "string", description: "Alias of id" },
      pattern: {
        type: "string",
        description: "JS regex expected in logs (ready|listening|error|…). Empty = wait until process ends",
      },
      timeout_ms: {
        type: "number",
        description: "Budget for this wait (default 60000, max 1200000 = 20min)",
      },
    }
  ),
];
