/**
 * Node smoke tests for loop guards + skill context pack (no VS Code UI).
 * Run: node scripts/test-agent-logic.mjs
 */
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "out");
const require = createRequire(import.meta.url);

const Module = require("module");
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "vscode") {
    return {
      workspace: {
        workspaceFolders: [
          {
            uri: { fsPath: path.resolve(__dirname, "..", "..", "..") },
          },
        ],
        getConfiguration: () => ({ get: () => undefined }),
      },
    };
  }
  return orig.apply(this, arguments);
};

const guardsPath = path.join(outDir, "agent", "loopGuards.js");
const packPath = path.join(outDir, "marketplace", "contextPack.js");

if (!fs.existsSync(guardsPath)) {
  console.error("Build first: npm run compile (missing", guardsPath, ")");
  process.exit(1);
}

const {
  detectGenerationLoop,
  shouldRegenerateWithoutTools,
  isRepeatToolCall,
  rememberToolCall,
  isSimilarTerminalLaunch,
  isExploreLoop,
  isProjectOverviewAsk,
  shellCommandMatchesToolName,
  toolDisableFamily,
  filterDefsExcluding,
  forgetReadFingerprintsForPath,
  detectPingPongLoop,
  pushCallSequence,
  AgentLoopDetector,
  detectThinkingRestate,
  SoftThinkingGuard,
  textSimilarity,
  findTailPeriodUnit,
} = require(guardsPath);
const { buildHubContextPack, collectAllSkillBlocks } = require(packPath);

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  OK  ${name}${detail ? " — " + detail : ""}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

console.log("## soft thinking guard");
check("similarity high for near-dup", textSimilarity(
  "The user asks about comfort in this environment and whether it is better.",
  "The user asks about comfort in this environment and if it is better overall."
) >= 0.7);
check("similarity low for new round", textSimilarity(
  "The user asks about comfort in this environment.",
  "Now checking TOOL_RESULT: read_file returned 72 lines, next I will summarize."
) < 0.55);
{
  const g = new SoftThinkingGuard({ escalateAfter: 500 });
  const a = g.filter("First complete thought about the task ends here.");
  check("first unit emits", a.emitDelta.length > 0 && !a.escalate);
  const unit = "SAME BLOCK OF REASONING TEXT THAT LOOPS. ";
  const tape = unit.repeat(6);
  const b = g.filter(a.emitDelta + " " + tape + tape);
  check("tail period soft-skips", b.emitDelta === "" && !!b.reason);
  g.reset();
  const c = g.filter("After tools I reflect on the new output and plan the edit.");
  check("reset allows post-tool reflection", c.emitDelta.length > 0);
  // Paraphrase reopen (comfort paste pattern)
  const g2 = new SoftThinkingGuard();
  g2.filter(
    "The user asks whether this environment is comfortable compared to another client. I will answer briefly."
  );
  const reopen = g2.filter(
    "The user asks whether this environment is comfortable compared to another client. I will answer briefly.\n\n" +
      "The user asks whether this environment is comfortable compared to another client and wants a short comparison."
  );
  check(
    "paraphrase reopen soft-skips",
    reopen.emitDelta === "" && /stem|unit|user_goal/i.test(reopen.reason || "")
  );
  // Post-tool: keep mute on «Пользователь хочет…» reopen (shared-guard pattern)
  const g3 = new SoftThinkingGuard();
  g3.filter("Пользователь хочет перейти в папку проекта и посмотреть файлы. Сначала list_files.");
  g3.allowPostToolReflection();
  const reopenRu = g3.filter(
    "Пользователь хочет перейти в папку проекта и посмотреть файлы. Теперь составлю план."
  );
  check(
    "post-tool user-goal reopen muted",
    reopenRu.emitDelta === "" && /stem/i.test(reopenRu.reason || "")
  );
  // Reopen must NOT softMute the whole post-tool round — TOOL_RESULT thinking still emits
  const reflect = g3.filter(
    "Пользователь хочет перейти в папку проекта и посмотреть файлы. Теперь составлю план.\n\n" +
      "TOOL_RESULT: 15 entries. Next I will read package.json."
  );
  check(
    "post-tool TOOL_RESULT after reopen still emits",
    /TOOL_RESULT/i.test(reflect.emitDelta)
  );
  g3.allowPostToolReflection();
  const reflect2 = g3.filter("TOOL_RESULT shows 15 entries. Next: read package.json.");
  check("post-tool reflection on evidence allowed", reflect2.emitDelta.length > 0);
  // Cross-language reopen (RU anchor → EN «The user wants…») muted via userStem/taskKeys
  const g4 = new SoftThinkingGuard();
  g4.setUserTask(
    "посмотри локальный форк Cursor, найди облачные вызовы и авторизацию, подключи Ollama"
  );
  g4.filter(
    "Пользователь просит посмотреть локальный форк Cursor и найти облачные вызовы и авторизацию."
  );
  g4.allowPostToolReflection();
  const enReopen = g4.filter(
    "The user wants me to look at the local Cursor fork, find cloud API calls and auth, then wire Ollama."
  );
  check(
    "cross-lang user-task reopen muted",
    enReopen.emitDelta === "" && /stem/i.test(enReopen.reason || "")
  );
  // noteVisibleProgress must NOT wipe user/anchor (unlike reset)
  g4.noteVisibleProgress();
  const enAgain = g4.filter(
    "The user wants me to look at the local Cursor fork and find cloud API calls."
  );
  check(
    "anchor kept after noteVisibleProgress",
    enAgain.emitDelta === "" && /stem/i.test(enAgain.reason || "")
  );
}
{
  const { stripToolMarkup } = require(path.join(outDir, "tools", "parser.js"));
  check("stripToolMarkup keeps space delta", stripToolMarkup(" ", { trim: false }) === " ");
  check("stripToolMarkup default still trims", stripToolMarkup("  x  ") === "x");
}
check(
  "tape unit detected",
  !!findTailPeriodUnit("hello world! ".repeat(20) + "hello world! ".repeat(8), 40)
);
check(
  "detectThinkingRestate near-dup paras",
  detectThinkingRestate(
    "The user asks whether this environment is comfortable compared to another client. I will answer briefly.\n\n" +
      "The user asks whether this environment is comfortable compared to another client. I will answer briefly and clearly."
  ).looping
);

console.log("## detectGenerationLoop");
check(
  "normal answer not loop",
  !detectGenerationLoop(
    "Файл создан. Проверил запуск — всё ок. Можешь открыть main.py."
  ).looping
);
check(
  "two similar sentences not loop",
  !detectGenerationLoop(
    "Сначала прочитал файл. Потом исправил ошибку. Запуск прошёл успешно."
  ).looping
);
const spam = "Ошибка в коде. ".repeat(12);
check("phrase spam is loop", detectGenerationLoop(spam).looping, spam.slice(0, 40));
check(
  "glyph collapse is loop",
  detectGenerationLoop("aaaaaaaaaaaaaaaaaaaaaaaaaaaa").looping
);

console.log("## shouldRegenerateWithoutTools");
check(
  "plan without tools → regen",
  shouldRegenerateWithoutTools(
    "создай файл hello.txt",
    "Сейчас создам файл hello.txt и напишу туда текст.",
    "",
    0
  )
);
check(
  "short final after tools → accept",
  !shouldRegenerateWithoutTools(
    "создай файл hello.txt",
    "Готово — создал hello.txt с текстом привет.",
    "",
    2
  )
);
check(
  "incomplete cut → regen",
  shouldRegenerateWithoutTools("исправь баг", "Исправляю ошибку в", "", 1)
);

console.log("## tool repeat — edit/verify (agent-loop-detector style)");
const seen = new Map();
rememberToolCall(seen, "read_file", { path: "a.ts" }, true);
check(
  "same failed write blocked",
  (() => {
    rememberToolCall(seen, "write_to_file", { path: "a.ts", content: "x" }, false);
    return isRepeatToolCall(seen, "write_to_file", { path: "a.ts", content: "x" });
  })()
);
check(
  "OK read_file may repeat (verify after edit)",
  !isRepeatToolCall(seen, "read_file", { path: "a.ts" })
);

const det = new AgentLoopDetector({ maxIdenticalCalls: 3 });
check("1st identical read ok", !det.record("read_file", { path: "a.ts" }).blocked);
check("2nd identical read ok", !det.record("read_file", { path: "a.ts" }).blocked);
check("3rd identical read blocked", det.record("read_file", { path: "a.ts" }).blocked);

const det2 = new AgentLoopDetector({ maxIdenticalCalls: 3 });
det2.record("read_file", { path: "b.ts" });
det2.record("read_file", { path: "b.ts" });
det2.noteProgress(); // simulate write
check(
  "after write, re-read allowed",
  !det2.record("read_file", { path: "b.ts" }).blocked
);

check(
  "re-read after forget fingerprints",
  (() => {
    const s = new Map();
    rememberToolCall(s, "read_file", { path: "c.ts" }, true);
    forgetReadFingerprintsForPath(s, "c.ts");
    return !isRepeatToolCall(s, "read_file", { path: "c.ts" });
  })()
);

check(
  "ping-pong needs 3 cycles",
  (() => {
    const seq = [];
    for (let i = 0; i < 4; i++) {
      pushCallSequence(seq, "grep", { pattern: "y" });
      pushCallSequence(seq, "read_file", { path: "x" });
    }
    return detectPingPongLoop(seq, 3);
  })()
);
check(
  "short edit-read not ping-pong",
  (() => {
    const seq = [];
    pushCallSequence(seq, "read_file", { path: "x" });
    pushCallSequence(seq, "replace_in_file", { path: "x" });
    pushCallSequence(seq, "read_file", { path: "x" });
    return !detectPingPongLoop(seq, 3);
  })()
);

rememberToolCall(
  seen,
  "run_in_terminal",
  { command: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive' },
  true
);
check(
  "truncated CS2 path is similar launch",
  isSimilarTerminalLaunch(seen, "run_in_terminal", {
    command: 'C:\\Program Files (x',
  })
);
check(
  "truncated CS2 path blocked as repeat",
  isRepeatToolCall(seen, "run_in_terminal", { command: 'C:\\Program Files (x' })
);
rememberToolCall(seen, "list_files", { path: "." }, true);
check("second list_files same path is explore loop", isExploreLoop(seen, "list_files", { path: "." }));
check(
  "second list_files same path blocked as repeat",
  isRepeatToolCall(seen, "list_files", { path: "." })
);
check(
  "list_files different path not blocked",
  !isRepeatToolCall(seen, "list_files", { path: "other" })
);
check(
  "list_files different path not explore loop",
  !isExploreLoop(seen, "list_files", { path: "app" })
);
check(
  "overview ask detected",
  isProjectOverviewAsk("привет посмотр ипроект")
);
const live = ["run_subagent", "run_in_terminal", "read_file", "list_subagents"];
check(
  "shell first-token matches live tool",
  shellCommandMatchesToolName("runSubagent", live) === "run_subagent" ||
    shellCommandMatchesToolName("runSubagent", live) === "runSubagent"
);
check(
  "shell run_subagent matches",
  shellCommandMatchesToolName('run_subagent "hi"', live) === "run_subagent"
);
check("python not a tool name", !shellCommandMatchesToolName('python -c "print(1)"', live));
check(
  "disable family expands terminal",
  toolDisableFamily("run_in_terminal").includes("execute_command")
);
check(
  "filterDefsExcluding drops disabled",
  filterDefsExcluding(
    [{ function: { name: "run_in_terminal" } }, { function: { name: "run_subagent" } }],
    new Set(["run_in_terminal", "execute_command"])
  ).length === 1
);

console.log("## context pack (workspace skills)");
const all = collectAllSkillBlocks();
check("found workspace skills", all.length >= 3, `count=${all.length}`);
const pack = buildHubContextPack({ userText: "исправь ошибку бота и проверь telegram" });
check("selected core skills", pack.skillCount >= 1, `skills=${pack.skillCount} ids=${(pack.selectedIds || []).join(",")}`);
check("pack has app-dev-verify or discipline", /app-dev-verify|Agent Discipline|Agent work pipeline/i.test(pack.text));

console.log("## Qwen XML tool_call parser");
{
  const { parseToolCalls, stripToolMarkup } = require(path.join(outDir, "tools", "parser.js"));
  const raw = `<tool_call>
<function=grep>
<parameter=path>
c:\\Users\\gordo\\.openclaw\\cursor-local\\resources\\app\\out
</parameter>
<parameter=pattern>
api\\.cursor\\.sh|cloud|auth
</parameter>
</function>
</tool_call>`;
  const calls = parseToolCalls(raw, { allowJson: true, allowXml: true });
  check("parses Qwen <function=grep>", calls.length === 1 && calls[0].name === "grep");
  check(
    "Qwen grep path arg",
    String(calls[0]?.arguments?.path || "").includes("cursor-local")
  );
  check("strip removes Qwen tool_call", !/<tool_call>/i.test(stripToolMarkup(raw)));
}

console.log("## Qwen plain user query (no user query found)");
const {
  hasPlainUserQuery,
  ensurePlainUserQuery,
  packChunkedContext,
  prepareMessagesForQwen,
  pinTaskAtEnd,
  normalizeMessagesForQwen,
} = require(path.join(outDir, "agent", "chunkedContext.js"));
check(
  "tool-only transcript has no plain user",
  !hasPlainUserQuery([
    { role: "system", content: "sys" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "list_files" } }] },
    { role: "tool", tool_name: "list_files", content: "dir\tapp" },
  ])
);
{
  const msgs = [
    { role: "system", content: "sys" },
    { role: "tool", tool_name: "list_files", content: "x".repeat(100) },
  ];
  check("ensure injects user", ensurePlainUserQuery(msgs, "сделай анализ проекта"));
  check("after ensure has plain user", hasPlainUserQuery(msgs));
}
{
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "оригинальный запрос" },
    { role: "tool", tool_name: "grep", content: "hit\n".repeat(5000) },
  ];
  prepareMessagesForQwen(msgs, "оригинальный запрос", 800);
  const last = msgs[msgs.length - 1];
  check(
    "task pin is LAST message (survives Ollama prune)",
    last.role === "user" && String(last.content).startsWith("[task]")
  );
  check(
    "pin is short continue — not full question again",
    String(last.content).startsWith("[task]\nnext") && !String(last.content).includes("оригинальный запрос")
  );
  check("tool shrunk before send", String(msgs.find((m) => m.role === "tool")?.content || "").length < 1200);
  pinTaskAtEnd(msgs, "again");
  check("pin dedupes", msgs.filter((m) => m.role === "user" && String(m.content).startsWith("[task]")).length === 1);
  const onlyUser = [
    { role: "user", content: "вопрос" },
  ];
  pinTaskAtEnd(onlyUser, "вопрос");
  check("no pin when last is already user", onlyUser.length === 1 && onlyUser[0].content === "вопрос");
}
{
  // Force pack: huge tool tails so user falls out of "recent"
  const hist = [
    { role: "system", content: "sys" },
    { role: "user", content: "глубокий анализ структуры" },
    { role: "assistant", content: "ok", tool_calls: [{ function: { name: "list_files" } }] },
    { role: "tool", tool_name: "list_files", content: ("file\tx\n").repeat(8000) },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file" } }] },
    { role: "tool", tool_name: "read_file", content: ("line\n").repeat(8000) },
  ];
  const packed = packChunkedContext(hist, {
    windowTokens: 2048,
    userText: "глубокий анализ структуры",
    systemPrompt: "sys",
    persistSlots: false,
  });
  check(
    "packed history keeps plain user (Qwen)",
    hasPlainUserQuery(packed.messages),
    `roles=${packed.messages.map((m) => m.role).join(",")}`
  );
  check(
    "packed has single leading system (Qwen)",
    packed.messages[0]?.role === "system" &&
      packed.messages.filter((m) => m.role === "system").length === 1
  );
}
{
  const msgs = [
    { role: "system", content: "sys1" },
    { role: "user", content: "hi" },
    { role: "system", content: "[VCTX] bad second system" },
    { role: "tool", tool_name: "grep", content: "x" },
  ];
  normalizeMessagesForQwen(msgs);
  check(
    "normalize merges systems to front",
    msgs[0].role === "system" &&
      msgs[0].content.includes("sys1") &&
      msgs[0].content.includes("VCTX") &&
      msgs.filter((m) => m.role === "system").length === 1
  );
}

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll agent-logic checks passed.");
