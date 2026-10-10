/**
 * Live probe: Ollama model tool_calls + incomplete detection.
 * Run: node scripts/probe-model.mjs
 */
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import Module from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const out = path.join(__dirname, "..", "out");

const origRequire = Module.prototype.require;
Module.prototype.require = function (id, ...rest) {
  if (id === "vscode") {
    return {
      workspace: {
        getConfiguration: () => ({ get: () => undefined }),
        workspaceFolders: [{ uri: { fsPath: "E:\\Work\\my_project" } }],
      },
      window: { showWarningMessage: async () => "Allow" },
      Uri: { file: (p) => ({ fsPath: p }) },
    };
  }
  return origRequire.call(this, id, ...rest);
};

const { TOOL_DEFINITIONS } = require(path.join(out, "tools", "parser.js"));
const {
  shouldRegenerateWithoutTools,
  looksLikeContinuingWork,
  hasStutteringRepetition,
} = require(path.join(out, "agent", "loopGuards.js"));

const MODEL = process.env.OLLAMA_MODEL || "huihui_ai/qwen3.5-abliterated:9b";
const BASE = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) console.log(`✓ ${name}`);
  else {
    failed++;
    console.error(`✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

async function chat(messages, { tools, think = false, num_predict = -1 } = {}) {
  const body = {
    model: MODEL,
    messages,
    stream: false,
    think,
    options: { temperature: 0.2, num_ctx: 8192, num_predict },
  };
  if (tools?.length) body.tools = tools;
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`chat ${res.status}: ${await res.text()}`);
  return res.json();
}

const toolsLite = TOOL_DEFINITIONS.filter((d) =>
  /^(read_file|replace_in_file|write_to_file|run_in_terminal|get_terminal_output|windows_desktop)$/i.test(
    d?.function?.name || ""
  )
);

console.log(`Model: ${MODEL}`);
console.log(`Tools in probe: ${toolsLite.map((t) => t.function.name).join(", ")}`);

// Local guards (no model)
const stutter =
  "I see! The terminal is still being blocked — that means something more radical is needed! Let's try get_terminal_output. I see! The terminal is still being blocked — that means something more radical is needed!";
ok("stutter guard", hasStutteringRepetition(stutter) || looksLikeContinuingWork(stutter));
ok(
  "blocked-narration regenerates",
  shouldRegenerateWithoutTools(
    "почини бота",
    "Терминал заблокирован — давайте слегка изменим команду:",
    "",
    20
  )
);

// Live: must emit tool_calls for a clear fix+run ask
const sys = `You are a coding agent. Use tools via native tool_calls only. Do not narrate without tools. Russian OK.`;
const user =
  "В main.py SyntaxError: await outside async function на строке с await application.bot.initialize(). Исправь через replace_in_file или write_to_file, потом run_in_terminal python main.py. Не пиши план без tools.";

console.log("\n— live tool_calls probe —");
const t0 = Date.now();
let raw;
try {
  raw = await chat(
    [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    { tools: toolsLite, think: false, num_predict: -1 }
  );
} catch (e) {
  console.error("Ollama error:", e.message || e);
  process.exit(1);
}
const ms = Date.now() - t0;
const msg = raw.message || {};
const tcs = msg.tool_calls || [];
const content = String(msg.content || "");
const thinking = String(msg.thinking || "");
console.log(`latency_ms=${ms} eval_count=${raw.eval_count || "?"} done_reason=${raw.done_reason || "?"}`);
console.log(`content_len=${content.length} thinking_len=${thinking.length} tool_calls=${tcs.length}`);
if (tcs.length) {
  for (const tc of tcs.slice(0, 5)) {
    const fn = tc.function || tc;
    console.log(`  → ${fn.name} ${JSON.stringify(fn.arguments || {}).slice(0, 120)}`);
  }
} else {
  console.log(`content preview: ${content.slice(0, 240).replace(/\n/g, " ")}`);
  if (thinking) console.log(`thinking preview: ${thinking.slice(0, 240).replace(/\n/g, " ")}`);
}

ok("emitted at least one tool_call", tcs.length > 0, `content=${content.slice(0, 80)}`);
const names = tcs.map((tc) => (tc.function || tc).name);
ok(
  "chose file fix tool",
  names.some((n) => /replace_in_file|write_to_file|read_file/i.test(n)),
  `got ${names.join(",") || "none"}`
);

// Live: truncated num_predict should look incomplete to our guards
console.log("\n— live truncation probe (num_predict=24) —");
const cut = await chat(
  [
    { role: "system", content: "Отвечай по-русски полными предложениями." },
    {
      role: "user",
      content: "Объясни в трёх предложениях, что делает async def main в Telegram-боте.",
    },
  ],
  { num_predict: 24, think: false }
);
const cutText = String(cut.message?.content || "").trim();
console.log(`cut done_reason=${cut.done_reason} text=${JSON.stringify(cutText)}`);
ok(
  "short predict flagged incomplete or regenerable",
  shouldRegenerateWithoutTools("объясни", cutText, "", 0) ||
    looksLikeContinuingWork(cutText) ||
    cut.done_reason === "length" ||
    /[,:;…"—]\s*$/.test(cutText) ||
    cutText.length < 40,
  cutText
);

if (failed) {
  console.error(`\n${failed} probe check(s) failed`);
  process.exit(1);
}
console.log("\nAll probe checks passed");
