/**
 * Long-horizon agent probe against E:\Work\agent-sandbox\complex-lab
 * Uses local Ollama model; simulates OllamaCode tool loop + parsers from extension out/.
 *
 * node scripts/probe-long-agent.mjs [model]
 */
import fs from "fs";
import path from "path";
import http from "http";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const parserPath = path.join(__dirname, "..", "extensions", "ollama-agent", "out", "tools", "parser.js");
const guardsPath = path.join(__dirname, "..", "extensions", "ollama-agent", "out", "agent", "loopGuards.js");
const {
  parseToolCallsFromTurn,
  hasIncompleteToolMarkup,
  stripToolMarkup,
} = require(parserPath);
const {
  SoftThinkingGuard,
  looksLikeContinuingWork,
  shouldRegenerateWithoutTools,
  detectGenerationLoop,
} = require(guardsPath);

const LAB = "E:\\Work\\agent-sandbox\\complex-lab";
const OUT = path.join(LAB, "long-probe-report.json");
const model = process.argv[2] || process.env.OLLAMA_MODEL || "agent36:latest";
const base = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
const MAX_STEPS = 14;
const REQ_TIMEOUT_MS = 600_000;

const PROMPT = `Ты агент в папке ${LAB}.

Сложное задание — доведи до конца, не останавливайся на полпути, не сдавайся после 1–2 tool:

1) Изучи структуру проекта (list_files рекурсивно по src/, tests/, config/).
2) Найди баг в math.js (деление на ноль) — прочитай файл, опиши баг.
3) Исправь buggyDivide: при b===0 кидай Error("division by zero"), иначе a/b. write_to_file.
4) Добавь в users.js функцию listUsers() возвращающую Object.values(DB). write_to_file.
5) Добавь в router.js маршрут GET /users → JSON список. write_to_file.
6) Создай tests/users.test.js с тестом listUsers (хотя бы 2 юзера).
7) Запусти тесты через run_in_terminal: node --test tests/math.test.js tests/users.test.js
8) Если тесты падают — почини и перезапусти.
9) Напиши REPORT.md с итогами на русском (что было сломано, что сделано, результат тестов).

Правила: thinking и ответы на русском. После TOOL_RESULT не пересказывай весь промпт — действуй. Сразу tool_calls, не «сейчас сделаю» без вызова.`;

const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List directory",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_to_file",
      description: "Write entire file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_in_terminal",
      description: "Run shell command in lab cwd",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
];

function postChat(body) {
  const data = JSON.stringify(body);
  const u = new URL(base + "/api/chat");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 11434,
        path: u.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(buf || "{}"), raw: buf });
          } catch {
            reject(new Error(`bad json ${res.statusCode}: ${buf.slice(0, 300)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(REQ_TIMEOUT_MS, () => req.destroy(new Error("timeout")));
    req.write(data);
    req.end();
  });
}

function resolveLab(p) {
  const raw = String(p || LAB);
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return path.normalize(path.join(LAB, raw));
}

function execTool(name, args) {
  try {
    if (name === "list_files") {
      const dir = resolveLab(args.path || ".");
      if (!fs.existsSync(dir)) return { ok: false, detail: `missing ${dir}` };
      const entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) =>
        e.isDirectory() ? `${e.name}/` : e.name
      );
      return { ok: true, detail: entries.join("\n") || "(empty)" };
    }
    if (name === "read_file") {
      const f = resolveLab(args.path);
      if (!fs.existsSync(f)) return { ok: false, detail: `missing ${f}` };
      let text = fs.readFileSync(f, "utf8");
      const off = Number(args.offset) || 0;
      const lim = Number(args.limit) || 0;
      if (off || lim) {
        const lines = text.split(/\r?\n/);
        text = lines.slice(off, lim ? off + lim : undefined).join("\n");
      }
      return { ok: true, detail: text.slice(0, 20_000) };
    }
    if (name === "write_to_file") {
      const f = resolveLab(args.path);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, String(args.content ?? ""), "utf8");
      return { ok: true, detail: `wrote ${f} (${Buffer.byteLength(String(args.content ?? ""))} B)` };
    }
    if (name === "run_in_terminal") {
      const { execSync } = require("child_process");
      const cmd = String(args.command || "");
      try {
        const out = execSync(cmd, {
          cwd: LAB,
          encoding: "utf8",
          timeout: 60_000,
          shell: true,
        });
        return { ok: true, detail: (out || "(no stdout)").slice(0, 12_000) };
      } catch (e) {
        const detail = `${e.stdout || ""}\n${e.stderr || ""}\n${e.message || e}`.slice(0, 12_000);
        return { ok: false, detail };
      }
    }
    return { ok: false, detail: `unknown tool ${name}` };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e) };
  }
}

function analyzeText(text) {
  const t = String(text || "");
  return {
    chars: t.length,
    glue: /[а-яёА-ЯЁ][A-Z]/.test(t) || /[a-z.][А-ЯЁ]/.test(t),
    enBleed: /\b(the|let me|I need|instead|BLOCKED)\b/i.test(t) && /[а-яё]/i.test(t),
    userRestate: /^(пользователь\s+(хочет|просит)|the user\s+(wants|asks))/im.test(t.trim()),
    hasToolXml: /<tool_call>|<function=/i.test(t),
    incompleteXml: hasIncompleteToolMarkup(t),
    continuing: looksLikeContinuingWork(t),
    genLoop: detectGenerationLoop(t).looping,
  };
}

async function main() {
  if (!fs.existsSync(LAB)) {
    console.error("lab missing:", LAB);
    process.exit(1);
  }
  console.log("LONG PROBE model=", model, "lab=", LAB, "steps<=", MAX_STEPS);

  const messages = [
    {
      role: "system",
      content:
        "You are a coding agent with tools. Language: Russian for thinking and final answers. " +
        "Prefer native tool_calls; XML <tool_call><function=…> also OK. " +
        "After TOOL_RESULT continue from evidence — do not restate the full user task. " +
        "Finish the whole checklist. num_predict unlimited.",
    },
    { role: "user", content: PROMPT },
  ];

  const thinkGuard = new SoftThinkingGuard();
  const rounds = [];
  let toolsExecuted = 0;
  let continueNudges = 0;
  let parsedFromThinkingOnly = 0;
  let incompleteRecoveries = 0;
  const fingerprints = new Map();
  let loopBlocks = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (toolsExecuted > 0) thinkGuard.allowPostToolReflection();
    const t0 = Date.now();
    let res;
    try {
      res = await postChat({
        model,
        messages,
        stream: false,
        think: true,
        tools: TOOL_DEFS,
        options: {
          temperature: 0.25,
          num_ctx: 65536,
          num_predict: -1,
        },
      });
    } catch (e) {
      console.error(`step ${step} REQUEST FAIL:`, e.message || e);
      rounds.push({ step, error: String(e.message || e), ms: Date.now() - t0 });
      break;
    }
    if (res.status >= 400) {
      console.error("ollama", res.status, res.raw?.slice(0, 400));
      rounds.push({ step, error: `http ${res.status}`, preview: res.raw?.slice(0, 200) });
      break;
    }

    const msg = res.json.message || {};
    const thinking = msg.thinking || "";
    const content = msg.content || "";
    const native = (msg.tool_calls || []).map((tc) => ({
      name: tc?.function?.name || tc?.name,
      arguments:
        typeof tc?.function?.arguments === "string"
          ? (() => {
              try {
                return JSON.parse(tc.function.arguments);
              } catch {
                return { raw: tc.function.arguments };
              }
            })()
          : tc?.function?.arguments || tc?.arguments || {},
      source: "native",
    }));

    const parsed = parseToolCallsFromTurn(content, thinking, {
      allowJson: true,
      allowXml: true,
    });
    const fromContent = parseToolCallsFromTurn(content, "", { allowJson: true, allowXml: true });
    const fromThinkOnly =
      parsed.length > 0 && fromContent.length === 0 && !native.length;
    if (fromThinkOnly) parsedFromThinkingOnly += 1;

    const byKey = new Map();
    for (const c of [...native, ...parsed]) {
      if (!c?.name) continue;
      const key = `${c.name}:${JSON.stringify(c.arguments || {})}`;
      if (!byKey.has(key)) byKey.set(key, c);
    }
    let calls = [...byKey.values()];

    const guard = thinkGuard.filter(thinking);
    const aThink = analyzeText(thinking);
    const aCont = analyzeText(content);
    const shouldCont = shouldRegenerateWithoutTools(PROMPT, stripToolMarkup(content), thinking, toolsExecuted);
    const incomplete =
      hasIncompleteToolMarkup(content) || hasIncompleteToolMarkup(thinking);

    const round = {
      step,
      ms: Date.now() - t0,
      done_reason: res.json.done_reason,
      thinkingChars: thinking.length,
      contentChars: content.length,
      thinkGuardReason: guard.reason || null,
      thinkGuardMuted: !guard.emitDelta && !!guard.reason,
      nativeTools: native.map((c) => c.name),
      parsedTools: parsed.map((c) => c.name),
      fromThinkOnly,
      incomplete,
      shouldContinue: shouldCont,
      think: aThink,
      content: aCont,
      thinkingPreview: thinking.slice(0, 220).replace(/\s+/g, " "),
      contentPreview: content.slice(0, 220).replace(/\s+/g, " "),
    };
    rounds.push(round);

    console.log(
      `step ${step}: native=${round.nativeTools.join(",") || "-"} parsed=${round.parsedTools.join(",") || "-"} ` +
        `think=${thinking.length} content=${content.length} fromThink=${fromThinkOnly} ` +
        `incomplete=${incomplete} cont=${shouldCont} mute=${round.thinkGuardMuted}:${round.thinkGuardReason || "-"} ` +
        `loop=${aCont.genLoop || aThink.genLoop} ms=${round.ms}`
    );

    messages.push({
      role: "assistant",
      content: stripToolMarkup(content) || (calls.length ? "" : content),
      thinking: stripToolMarkup(thinking) || thinking || undefined,
      tool_calls: native.length
        ? msg.tool_calls
        : calls.length
          ? calls.map((c) => ({
              type: "function",
              function: { name: c.name, arguments: c.arguments || {} },
            }))
          : undefined,
    });

    if (!calls.length) {
      if ((incomplete || shouldCont) && continueNudges < 6 && step + 1 < MAX_STEPS) {
        continueNudges += 1;
        if (incomplete) incompleteRecoveries += 1;
        messages.push({
          role: "user",
          content: incomplete
            ? "[system] tool_call обрезан. Допиши полный tool_call / native tools. Не итог."
            : "[system] Ты описал шаг без tool_calls. Сразу вызови нужный tool. Язык = русский.",
        });
        console.log(`  → continue nudge #${continueNudges}`);
        continue;
      }
      console.log("  → final (no tools)");
      break;
    }

    // Soft loop detector on identical tool+args
    const fresh = [];
    for (const c of calls) {
      const fp = `${c.name}:${JSON.stringify(c.arguments || {})}`;
      const n = (fingerprints.get(fp) || 0) + 1;
      fingerprints.set(fp, n);
      if (n >= 3) {
        loopBlocks += 1;
        messages.push({
          role: "tool",
          tool_name: c.name,
          content: `[TOOL_RESULT]\ntool: ${c.name}\nstatus: BLOCKED\nsummary: identical args ×${n}\nhint: смени args или другой tool\n[/TOOL_RESULT]`,
        });
        console.log(`  BLOCKED ${c.name} ×${n}`);
      } else {
        fresh.push(c);
      }
    }

    if (!fresh.length) {
      messages.push({
        role: "user",
        content:
          "[system] Петля tool+args. Другой tool / другие args. Не останавливайся.",
      });
      continue;
    }

    for (const c of fresh) {
      const result = execTool(c.name, c.arguments || {});
      toolsExecuted += 1;
      const block = [
        "[TOOL_RESULT]",
        `tool: ${c.name}`,
        `status: ${result.ok ? "OK" : "FAILED"}`,
        `summary: ${result.ok ? "ok" : "error"}`,
        `detail:\n${result.detail}`,
        "[/TOOL_RESULT]",
      ].join("\n");
      messages.push({ role: "tool", tool_name: c.name, content: block });
      console.log(`  exec ${c.name} → ${result.ok ? "OK" : "FAIL"} (${String(result.detail).slice(0, 80).replace(/\s+/g, " ")})`);
    }
  }

  const reportExists = fs.existsSync(path.join(LAB, "REPORT.md"));
  const usersTest = fs.existsSync(path.join(LAB, "tests", "users.test.js"));
  let mathSrc = "";
  try {
    mathSrc = fs.readFileSync(path.join(LAB, "src", "math.js"), "utf8");
  } catch {
    /* */
  }
  const divideFixed = /division by zero|b\s*===?\s*0/i.test(mathSrc);

  const summary = {
    at: new Date().toISOString(),
    model,
    lab: LAB,
    steps: rounds.length,
    toolsExecuted,
    continueNudges,
    incompleteRecoveries,
    parsedFromThinkingOnly,
    loopBlocks,
    maxThinkingChars: Math.max(0, ...rounds.map((r) => r.thinkingChars || 0)),
    maxContentChars: Math.max(0, ...rounds.map((r) => r.contentChars || 0)),
    anyGlue: rounds.some((r) => r.think?.glue || r.content?.glue),
    anyEnBleed: rounds.some((r) => r.think?.enBleed || r.content?.enBleed),
    anyGenLoop: rounds.some((r) => r.think?.genLoop || r.content?.genLoop),
    anyIncomplete: rounds.some((r) => r.incomplete),
    thinkMutedRounds: rounds.filter((r) => r.thinkGuardMuted).length,
    artifacts: { reportExists, usersTest, divideFixed },
    rounds,
  };

  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2), "utf8");
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify({
    steps: summary.steps,
    toolsExecuted: summary.toolsExecuted,
    continueNudges: summary.continueNudges,
    parsedFromThinkingOnly: summary.parsedFromThinkingOnly,
    incompleteRecoveries: summary.incompleteRecoveries,
    loopBlocks: summary.loopBlocks,
    maxThinkingChars: summary.maxThinkingChars,
    maxContentChars: summary.maxContentChars,
    anyGlue: summary.anyGlue,
    anyEnBleed: summary.anyEnBleed,
    anyGenLoop: summary.anyGenLoop,
    artifacts: summary.artifacts,
  }, null, 2));
  console.log("wrote", OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
