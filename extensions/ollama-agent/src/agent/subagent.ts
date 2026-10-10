import { OllamaClient, ChatMessage } from "../ollama/client";
import { OllamaCodeConfig } from "../config";
import { parseToolCalls, TOOL_DEFINITIONS, ToolCall } from "../tools/parser";
import { executeTool } from "../tools/executor";

const READ_TOOLS = new Set([
  "read_file",
  "list_files",
  "search_files",
  "grep",
  "repo_map",
  "get_diagnostics",
]);

export async function runSubagent(params: {
  client: OllamaClient;
  cfg: OllamaCodeConfig;
  model: string;
  goal: string;
  mode?: "read" | "implement";
  maxSteps?: number;
}): Promise<string> {
  const { client, cfg, model } = params;
  const maxSteps = params.maxSteps ?? 4;
  const mode = params.mode || "read";
  const goal = (params.goal || "").trim();
  // Fast path: «напиши привет» — no second model round-trip / no tools
  if (
    goal.length < 100 &&
    /^(напиши|скажи|напечатай|print|say|write)\b/i.test(goal) &&
    /(привет|hello|\bhi\b)/i.test(goal)
  ) {
    const hello = /hello|\bhi\b/i.test(goal) && !/привет/i.test(goal) ? "Hello!" : "привет";
    return `[SUBAGENT_RESULT]\nmode: ${mode}\ngoal: ${goal}\n${hello}\n[/SUBAGENT_RESULT]`;
  }
  const system =
    mode === "read"
      ? "Ты read-only сабагент. Только чтение/поиск. Кратко суммируй находки. Не пиши файлы."
      : "Ты implement-сабагент. Сделай узкую правку через tools. Кратко отчитай результат.";

  const history: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: goal },
  ];

  const allowed = TOOL_DEFINITIONS.filter((t) => {
    const name = t.function.name;
    if (mode === "read") return READ_TOOLS.has(name);
    return name !== "run_subagent";
  });

  const notes: string[] = [];

  for (let step = 0; step < maxSteps; step++) {
    const { message } = await client.chat({
      model,
      messages: history,
      tools: allowed,
      options: {
        temperature: cfg.ollama.temperature,
        num_ctx: Math.min(cfg.ollama.numCtx, 8192),
      },
      keep_alive: cfg.ollama.keepAlive,
    });
    const text = message.content || "";
    history.push({ role: "assistant", content: text });
    notes.push(text.slice(0, 1500));

    const calls = parseToolCalls(text, {
      allowJson: cfg.tools.allowJson,
      allowXml: cfg.tools.allowXml,
    }).filter((c) => (mode === "read" ? READ_TOOLS.has(c.name) : c.name !== "run_subagent"));

    if (!calls.length) break;

    for (const call of calls.slice(0, 4)) {
      const result = await executeTool(call as ToolCall, cfg, { subagent: true });
      notes.push(result.summary || result.output.slice(0, 800));
      history.push({
        role: "tool",
        tool_name: call.name,
        content: result.output.slice(0, 6000),
      });
    }
  }

  return `[SUBAGENT_RESULT]\nmode: ${mode}\ngoal: ${goal}\n${notes.join("\n---\n").slice(0, 8000)}\n[/SUBAGENT_RESULT]`;
}
