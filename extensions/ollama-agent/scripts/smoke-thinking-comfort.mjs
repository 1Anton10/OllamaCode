/**
 * Reproduce soft-guard + parser on the comfort/OpenClaw paste; optionally hit Ollama.
 * Run: node scripts/smoke-thinking-comfort.mjs
 *      OLLAMA_SMOKE=1 node scripts/smoke-thinking-comfort.mjs
 */
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Module = require("module");
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "vscode") {
    return {
      workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({ get: () => undefined }),
      },
    };
  }
  return orig.apply(this, arguments);
};

const {
  SoftThinkingGuard,
  textSimilarity,
  detectThinkingRestate,
} = require(path.join(__dirname, "../out/agent/loopGuards.js"));
const {
  ThinkingTagStreamParser,
  splitThinkingContent,
  stripThinkingTags,
} = require(path.join(__dirname, "../out/ollama/thinkingTags.js"));

const sample = fs.readFileSync(
  path.join(__dirname, "fixtures/comfort-thinking-sample.txt"),
  "utf8"
);

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) console.log("  OK ", name, detail);
  else {
    failed++;
    console.error("  FAIL", name, detail);
  }
}

console.log("## soft guard on comfort paste (streamed)");
const g = new SoftThinkingGuard({ escalateAfter: 900 });
let acc = "";
let emitted = "";
for (let i = 40; i <= sample.length; i += 40) {
  acc = sample.slice(0, i);
  const v = g.filter(acc);
  if (v.emitDelta) emitted += v.emitDelta;
}
const ratio = emitted.length / Math.max(1, sample.length);
console.log("  emitted/sample", emitted.length, "/", sample.length, "=", ratio.toFixed(2));
check("soft-skips restates (emit < 55%)", ratio < 0.55, `ratio=${ratio.toFixed(2)}`);
check("detectThinkingRestate flags sample", detectThinkingRestate(sample).looping);

console.log("## opener similarity");
const a =
  "Пользователь спрашивает о моём комфорте в текущем окружении и сравнивает с OpenClaw";
const b =
  "Пользователь спрашивает, комфортно ли мне в текущем окружении и лучше ли оно OpenClaw";
check("ru openers similar", textSimilarity(a, b) >= 0.72, textSimilarity(a, b).toFixed(3));

console.log("## leak tags");
const leak =
  "Нужно ответить короткоassistant <think>\n\nassistant <think>\n\nДа, тут лучше. В OpenClow действительно циклился.";
const split = splitThinkingContent(leak);
const stripped = stripThinkingTags(leak);
const parser = new ThinkingTagStreamParser();
const p1 = parser.push(leak);
const p2 = parser.flush();
const content = [...p1.contentDeltas, ...p2.contentDeltas].join("");
const thinking = [...p1.thinkingDeltas, ...p2.thinkingDeltas].join("");
console.log("  split.content", JSON.stringify(split.content).slice(0, 120));
console.log("  stripped", JSON.stringify(stripped).slice(0, 120));
console.log("  stream content", JSON.stringify(content).slice(0, 120));
check(
  "no raw <think> in content",
  !/assistant\s*<think>|<think>/i.test(split.content + content + stripped)
);
check("final answer kept", /Да,\s*тут лучше/i.test(split.content + content + stripped));

const { scrubThinkLeaks: scrub } = require(path.join(__dirname, "../out/ollama/thinkingTags.js"));
const glued = "раньше.assistant <think>\n\nassistant <think>\n\nДа, здесь комфортнее.";
check(
  "scrub glued assistant <think> in thinking UI text",
  !/assistant\s*<think>|<think>/i.test(scrub(glued)) && /комфортнее/i.test(scrub(glued)),
  scrub(glued).slice(0, 80)
);
check("scrub keeps space-only delta", scrub(" ") === " ");
check("scrub keeps newline-only delta", scrub("\n") === "\n");
let streamed = "";
for (const part of ["Все", " ", "5", " ", "инструментов", "\n\n", "## Title", "\n\n", "| A | B |", "\n", "|---|---|", "\n", "| 1 | 2 |"]) {
  streamed += scrub(part);
}
check(
  "streamed spaces/newlines survive",
  streamed.includes("Все 5 инструментов") && /\n\n## Title\n\n\| A \|/.test(streamed),
  JSON.stringify(streamed).slice(0, 120)
);
const { normalizeAssistantMarkdown } = require(path.join(
  __dirname,
  "../out/ollama/assistantMarkdown.js"
));
const smashed = "## Результаты | Инструмент | Статус |\n|---|---|---|\n| a | ok | x |";
const fixed = normalizeAssistantMarkdown(smashed);
check(
  "normalize splits glued heading+table",
  /^## Результаты\n\n\| Инструмент/m.test(fixed),
  JSON.stringify(fixed).slice(0, 100)
);
const { isToolAuditAsk } = require(path.join(__dirname, "../out/agent/loopGuards.js"));
check(
  "tool audit ask detected",
  isToolAuditAsk("проверь все инструменты в пустую и некоторые с ошибками")
);

async function live() {
  const model = process.env.OLLAMA_MODEL || "agent36:latest";
  // Prefer think-capable local agent models; avoid coder tags that reject think=true.
  const base = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      think: true,
      messages: [
        {
          role: "system",
          content:
            "Ты локальный агент OllamaCode. На обычные вопросы отвечай коротко по-русски после краткого thinking. Не повторяй одну мысль разными словами.",
        },
        {
          role: "user",
          content:
            "тебе комфортно в текущем окружении? оно лучше чем openclow? там ты циклился говоря одно и тоже разными фразами",
        },
      ],
      options: { num_predict: 900, temperature: 0.2, num_ctx: 8192 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status} ${await res.text()}`);
  const data = await res.json();
  const thinkingLive = data?.message?.thinking || "";
  const contentLive = data?.message?.content || "";
  const dir = path.join(process.env.USERPROFILE || process.env.HOME || ".", ".ollamacode");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "last-live-comfort.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        model,
        thinkingLen: thinkingLive.length,
        contentLen: contentLive.length,
        thinking: thinkingLive.slice(0, 4000),
        content: contentLive.slice(0, 2000),
        restate: detectThinkingRestate(thinkingLive),
      },
      null,
      2
    ),
    "utf8"
  );
  console.log("## live ollama", model);
  console.log("  thinkingLen", thinkingLive.length, "contentLen", contentLive.length);
  console.log("  content preview", contentLive.slice(0, 240).replace(/\s+/g, " "));
  check("live has content or thinking", !!(contentLive.trim() || thinkingLive.trim()));
  if (thinkingLive.length > 400) {
    const g2 = new SoftThinkingGuard({ escalateAfter: 900, simThreshold: 0.72 });
    let em = "";
    for (let i = 80; i <= thinkingLive.length; i += 80) {
      const v = g2.filter(thinkingLive.slice(0, i));
      em += v.emitDelta;
    }
    const r = em.length / thinkingLive.length;
    console.log("  live emit ratio", r.toFixed(2));
  }
}

(async () => {
  if (process.env.OLLAMA_SMOKE === "1") {
    try {
      await live();
    } catch (e) {
      failed++;
      console.error("  FAIL live", e?.message || e);
    }
  } else console.log("## live skipped (OLLAMA_SMOKE=1)");
  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log("\nSmoke OK");
})();
