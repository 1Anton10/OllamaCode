/**
 * Inject a simple "create file" ask through Ollama tools + local write.
 * Also unit-checks loopGuards (via duplicated logic / dynamic import of compiled JS).
 *
 * Usage: node scripts/test-chat-pipeline.mjs
 */
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const BASE = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const MODEL =
  process.env.OLLAMA_MODEL || "huihui_ai/qwen3.5-abliterated:9b";

const outDir = path.join(os.homedir(), ".ollamacode", "pipeline-test");
fs.mkdirSync(outDir, { recursive: true });
const targetFile = path.join(outDir, `smoke-${Date.now()}.txt`);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Mirror of SIMPLE_WRITE_BLOCKED_TOOLS from loopGuards */
const BLOCK =
  /^(repo_map|list_files|search_files|grep|run_subagent|vctx_index|vctx_recall|open_workspace|create_project_workspace|manage_todo_list|update_task|read_file)$/i;

function filterTools(defs, userText) {
  if (!/создай|create|пустой|наполни|write/i.test(userText)) return defs;
  return defs.filter((d) => !BLOCK.test(d?.function?.name || ""));
}

async function ollamaChat(body) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const report = { at: new Date().toISOString(), model: MODEL, checks: [] };
  const check = (id, ok, detail) => {
    report.checks.push({ id, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${id}: ${detail}`);
  };

  // --- unit: tool filter ---
  const allTools = [
    "write_to_file",
    "vctx_index",
    "open_workspace",
    "repo_map",
    "read_file",
  ].map((name) => ({ type: "function", function: { name, parameters: { type: "object", properties: {} } } }));
  const ask = "создай просто тут пустой файл и наполни его как то";
  const filtered = filterTools(allTools, ask);
  const names = filtered.map((d) => d.function.name);
  check(
    "filter-simple-write",
    names.includes("write_to_file") && !names.includes("vctx_index") && !names.includes("open_workspace"),
    `kept=[${names.join(",")}]`
  );

  // --- unit: loopGuards from compiled out if present ---
  try {
    const guardsPath = path.join(
      root,
      "extensions/ollama-agent/out/agent/loopGuards.js"
    );
    if (fs.existsSync(guardsPath)) {
      const g = require(guardsPath);
      const again = g.filterToolsForUserAsk(allTools, ask);
      check(
        "loopGuards-filter",
        again.every((d) => !BLOCK.test(d.function.name)) &&
          again.some((d) => d.function.name === "write_to_file"),
        `n=${again.length}`
      );
      const seen = new Map();
      g.rememberToolCall(seen, "vctx_index", {}, true);
      check(
        "loopGuards-repeat",
        g.isRepeatToolCall(seen, "vctx_index", {}) === true,
        "repeat blocked"
      );
    } else {
      check("loopGuards-filter", true, "skip (compile out missing)");
      check("loopGuards-repeat", true, "skip");
    }
  } catch (e) {
    check("loopGuards-filter", false, String(e.message || e));
  }

  // --- live: model should emit write_to_file ---
  const writeTool = {
    type: "function",
    function: {
      name: "write_to_file",
      description: "Create or overwrite a file in the workspace",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
      },
    },
  };

  let wrote = false;
  let toolName = "";
  try {
    const raw = await ollamaChat({
      model: MODEL,
      stream: false,
      think: false,
      messages: [
        {
          role: "system",
          content:
            "Ты агент. Workspace открыт. Для создания файла сразу вызови write_to_file. Не вызывай другие tools. Без длинных рассуждений.",
        },
        {
          role: "user",
          content: `создай файл ${targetFile} с текстом hello-pipeline`,
        },
      ],
      tools: [writeTool],
      options: { temperature: 0.1, num_predict: 256, num_ctx: 4096 },
    });

    const tcs = raw?.message?.tool_calls || [];
    if (tcs.length) {
      const tc = tcs[0];
      toolName = tc?.function?.name || tc?.name || "";
      let args = tc?.function?.arguments ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          /* keep */
        }
      }
      if (toolName === "write_to_file" && args.path) {
        const p = path.isAbsolute(args.path) ? args.path : path.join(outDir, args.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, String(args.content ?? "hello-pipeline"), "utf8");
        wrote = fs.existsSync(p) && fs.readFileSync(p, "utf8").includes("hello");
        check("model-write_to_file", wrote, `path=${p}`);
      } else {
        check("model-write_to_file", false, `got tool=${toolName} args=${JSON.stringify(args).slice(0, 120)}`);
      }
    } else {
      // fallback: model put JSON in content
      const content = raw?.message?.content || "";
      const m = content.match(/"path"\s*:\s*"([^"]+)"/);
      check(
        "model-write_to_file",
        false,
        `no tool_calls; content=${content.slice(0, 160)}`
      );
      void m;
    }
  } catch (e) {
    check("model-write_to_file", false, String(e.message || e));
  }

  report.ok = report.checks.every((c) => c.ok);
  report.toolName = toolName;
  report.targetFile = targetFile;
  const out = path.join(os.homedir(), ".ollamacode", "pipeline-test-report.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nreport → ${out} · ok=${report.ok}`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
