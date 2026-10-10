/**
 * Live probe: broad RU task against E:\\Work\\agent-sandbox via Ollama HTTP.
 * Observes thinking / content glue / tool_calls / early stop — no VS Code host.
 *
 * Usage: node scripts/probe-agent-pipeline.mjs [model]
 */
import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sandbox = "E:\\Work\\agent-sandbox";
const outLog = path.join(sandbox, "probe-run.json");
const model = process.argv[2] || process.env.OLLAMA_MODEL || "qwen3:8b";
const base = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");

const PROMPT = `Рабочая папка: ${sandbox}.

Сделай широкое задание целиком (не останавливайся на полпути):
1) list_files / опиши что уже есть в папке
2) создай файл notes.md с кратким планом на русском
3) допиши в notes.md секцию «Итог» когда закончишь
4) ответь итогом на русском

Thinking и ответ — только на русском. Не переключайся на английский. Не пересказывай этот промпт после каждого шага — действуй по результатам.`;

function postJson(urlPath, body) {
  const u = new URL(base + urlPath);
  const data = JSON.stringify(body);
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
          } catch (e) {
            reject(new Error(`bad json ${res.statusCode}: ${buf.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(600_000, () => {
      req.destroy(new Error("timeout"));
    });
    req.write(data);
    req.end();
  });
}

function analyze(text) {
  const t = String(text || "");
  const glue = /[а-яёА-ЯЁ][A-Z]/.test(t) || /[a-z.][А-ЯЁ]/.test(t);
  const hasEn =
    /\b(the|let me|I need|BLOCKED|instead of|reading)\b/i.test(t) &&
    /[а-яё]/i.test(t);
  const continuing =
    /\b(давай|сейчас|прочитаю|let me|i need|начну)\b/i.test(t) &&
    !/\b(готово|итог|done)\b/i.test(t);
  return { glue, hasEn, continuing, chars: t.length };
}

async function main() {
  if (!fs.existsSync(sandbox)) fs.mkdirSync(sandbox, { recursive: true });
  console.log("probe model=", model, "sandbox=", sandbox);

  const tools = [
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files in a folder",
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
        name: "write_to_file",
        description: "Write a file",
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
  ];

  const messages = [
    {
      role: "system",
      content:
        "You are a coding agent. Language: reply AND thinking in the user's language only (RU). " +
        "After TOOL_RESULT continue from evidence — do not restate the user request. Prefer tool_calls over prose plans.",
    },
    { role: "user", content: PROMPT },
  ];

  const rounds = [];
  let toolsExecuted = 0;

  for (let step = 0; step < 6; step++) {
    const res = await postJson("/api/chat", {
      model,
      messages,
      stream: false,
      think: true,
      tools,
      options: { temperature: 0.3, num_ctx: 16384, num_predict: -1 },
    });
    if (res.status >= 400) {
      console.error("ollama error", res.status, res.raw?.slice(0, 400));
      process.exit(1);
    }
    const msg = res.json.message || {};
    const thinking = msg.thinking || "";
    const content = msg.content || "";
    const tcs = msg.tool_calls || [];
    const aThink = analyze(thinking);
    const aCont = analyze(content);
    const round = {
      step,
      done_reason: res.json.done_reason,
      thinkingChars: thinking.length,
      contentChars: content.length,
      toolCalls: tcs.map((t) => t?.function?.name || t?.name),
      think: aThink,
      content: aCont,
      thinkingPreview: thinking.slice(0, 280),
      contentPreview: content.slice(0, 280),
    };
    rounds.push(round);
    console.log(
      `step ${step}: tools=${round.toolCalls.join(",") || "-"} think=${thinking.length} content=${content.length} glue=${aCont.glue||aThink.glue} enBleed=${aCont.hasEn||aThink.hasEn} continuing=${aCont.continuing} done=${res.json.done_reason}`
    );

    messages.push({
      role: "assistant",
      content,
      thinking: thinking || undefined,
      tool_calls: tcs.length ? tcs : undefined,
    });

    if (!tcs.length) {
      if (aCont.continuing && toolsExecuted > 0 && step < 5) {
        messages.push({
          role: "user",
          content:
            "[system] Ты описал следующий шаг текстом, но tool_calls нет. Сразу вызови tool. Язык = русский.",
        });
        continue;
      }
      break;
    }

    for (const tc of tcs) {
      const name = tc?.function?.name || tc?.name;
      let args = tc?.function?.arguments ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      let detail = "";
      if (name === "list_files") {
        const p = args.path || sandbox;
        detail = fs.existsSync(p)
          ? fs.readdirSync(p).join("\n")
          : `missing: ${p}`;
      } else if (name === "write_to_file") {
        const p = path.isAbsolute(args.path)
          ? args.path
          : path.join(sandbox, args.path || "out.txt");
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, String(args.content || ""), "utf8");
        detail = `wrote ${p} (${Buffer.byteLength(String(args.content || ""))} bytes)`;
      } else {
        detail = `unknown tool ${name}`;
      }
      toolsExecuted += 1;
      messages.push({
        role: "tool",
        tool_name: name,
        content: `[TOOL_RESULT]\ntool: ${name}\nstatus: OK\nsummary: ok\ndetail:\n${detail}\n[/TOOL_RESULT]`,
      });
    }
  }

  const report = {
    at: new Date().toISOString(),
    model,
    sandbox,
    toolsExecuted,
    rounds,
    notesMd: fs.existsSync(path.join(sandbox, "notes.md"))
      ? fs.readFileSync(path.join(sandbox, "notes.md"), "utf8").slice(0, 800)
      : null,
  };
  fs.writeFileSync(outLog, JSON.stringify(report, null, 2), "utf8");
  console.log("wrote", outLog);
  const anyGlue = rounds.some((r) => r.think.glue || r.content.glue);
  const anyEn = rounds.some((r) => r.think.hasEn || r.content.hasEn);
  const stoppedMid = rounds.length && rounds[rounds.length - 1].content.continuing && !rounds[rounds.length - 1].toolCalls.length;
  console.log("summary: glue=", anyGlue, "enBleed=", anyEn, "stoppedMid=", !!stoppedMid, "tools=", toolsExecuted);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
