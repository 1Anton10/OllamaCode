/**
 * Unit checks for orchestration (no Ollama / no VS Code).
 * Run: node scripts/test-orchestrate.mjs
 */
import Module from "module";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const out = path.join(__dirname, "..", "out");

const origRequire = Module.prototype.require;
Module.prototype.require = function (id, ...rest) {
  if (id === "vscode") {
    return {
      window: { showWarningMessage: async () => "Allow", showInputBox: async () => "" },
      workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() } }] },
      Uri: { file: (p) => ({ fsPath: p }) },
    };
  }
  return origRequire.call(this, id, ...rest);
};

const {
  shouldRegenerateWithoutTools,
  looksLikeContinuingWork,
  looksIncompleteUtterance,
  hasStutteringRepetition,
  isRepeatToolCall,
  rememberToolCall,
  forgetTerminalLaunchFingerprints,
  needsDesktopE2eVerify,
} = require(path.join(out, "agent", "loopGuards.js"));
const { resolveReadWindow } = require(path.join(out, "tools", "readWindow.js"));
const { SubagentPool, defaultWaitForMode } = require(path.join(out, "agent", "subagentPool.js"));
const {
  looksLikeLongRunningCommand,
  forceBackgroundTerminalArgs,
  stripShellChrome,
  isEmptyTerminalOutput,
  diagnoseBotTerminalLaunch,
} = require(path.join(out, "tools", "nativeTerminalBridge.js"));
const {
  TerminalIdTracker,
  isTerminalUuid,
  extractTerminalIds,
} = require(path.join(out, "tools", "terminalIds.js"));

let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) console.log(`✓ ${name}`);
  else {
    failed++;
    console.error(`✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

// --- agent contract ---
ok(
  "mid-work Ага detected",
  looksLikeContinuingWork("Ага! Нужно создать два HTTPRequest")
);
ok(
  "empty+thinking after tools continues loop",
  shouldRegenerateWithoutTools(
    "почини бота",
    "",
    "I need to continue reading the file to see where the duplicate main() ends",
    12
  )
);
ok(
  "real done accepted",
  !shouldRegenerateWithoutTools("почини бота", "Готово. Бот стартует без traceback.", "", 12)
);
ok(
  "short mid-work text after tools accepted (not empty)",
  !shouldRegenerateWithoutTools("почини бота", "Ага! Давай подправим .env", "", 12)
);
ok(
  "cut mid-quote incomplete",
  looksIncompleteUtterance('Отлично! Файл обновлён — теперь бот инициализирует себя "')
);
ok(
  "cut mid-quote regenerates",
  shouldRegenerateWithoutTools(
    "почини бота",
    'Отлично! Файл обновлён — теперь бот инициализирует себя "',
    "",
    15
  )
);
ok(
  "complete sentence ok",
  !looksIncompleteUtterance("Отлично! Файл обновлён. Бот инициализирует себя при старте.")
);
const engLoop =
  "Now that the file is fixed with 'await main()', I should run the bot again to see if it works properly. Now that the file is fixed with 'await main()', I should run the bot again to see if it works properly.";
ok("english continuing detected", looksLikeContinuingWork(engLoop));
ok("stutter detected", hasStutteringRepetition(engLoop));

const {
  detectGenerationLoop,
  GENERATION_LOOP_NUDGE,
} = require(path.join(out, "agent", "loopGuards.js"));

const mashed =
  "The widget registry might be loaded lazily so I should inspect the module graph again. " +
  "The widget registry might be loaded lazily so I should inspect the module graph again. " +
  "The widget registry might be loaded lazily so I should inspect the module graph again. " +
  "The widget registry might be loaded lazily so I should inspect the module graph again.";
ok("mashed loop detected", detectGenerationLoop(mashed).looping === true);
ok(
  "long mashed triggers regenerate",
  shouldRegenerateWithoutTools("fix the startup error", mashed, "", 0)
);
ok(
  "loop after tools still regenerates",
  shouldRegenerateWithoutTools("fix it", "", mashed, 5)
);
ok(
  "normal answer not loop",
  !detectGenerationLoop(
    "ModuleNotFoundError: No module named 'acme.widgets'. Add it to requirements and reinstall."
  ).looping
);
ok("nudge asks for evidence tools", /evidence|TOOL_RESULT|tool\(s\)|gather evidence/i.test(GENERATION_LOOP_NUDGE));

// --- read_file window: short file always full ---
const shortFile = Array.from({ length: 257 }, (_, i) => `line-${i + 1}`).join("\n");
const tiny = resolveReadWindow({ text: shortFile, offset: 200, limit: 30 });
ok("short file expands to entire", tiny.entireFile === true && tiny.lineCount === 257);
ok("short file EOF hint", /EOF: entire file/i.test(tiny.hint));
ok("short file body has start", tiny.body.startsWith("line-1"));
ok("short file body has end", /line-257\s*$/.test(tiny.body));

const bigLines = Array.from({ length: 1200 }, (_, i) => `L${i + 1}`).join("\n");
const page = resolveReadWindow({ text: bigLines, offset: 100, limit: 50 });
ok("large file respects page", page.entireFile === false && page.fromLine === 101 && page.toLine === 150);
ok("large file partial hint", /Partial read/i.test(page.hint));

// --- re-read allowed for successful reads ---
const seen = new Map();
rememberToolCall(seen, "read_file", { path: "a.py" }, true);
ok(
  "successful read_file not fingerprint-blocked",
  !isRepeatToolCall(seen, "read_file", { path: "a.py" })
);
rememberToolCall(seen, "replace_in_file", { path: "a.py", old: "x", new: "y" }, false);
ok(
  "failed replace blocked",
  isRepeatToolCall(seen, "replace_in_file", { path: "a.py", old: "x", new: "y" })
);
const launchArgs = { command: "python main.py", isBackground: true };
rememberToolCall(seen, "run_in_terminal", launchArgs, true);
ok(
  "bot launch blocked until clear",
  isRepeatToolCall(seen, "run_in_terminal", launchArgs)
);
ok("forget launch fps", forgetTerminalLaunchFingerprints(seen) >= 1);
ok(
  "bot launch allowed after forget",
  !isRepeatToolCall(seen, "run_in_terminal", launchArgs)
);

// --- wait policy ---
ok("read default wait=false", defaultWaitForMode("read", undefined) === false);
ok("implement default wait=true", defaultWaitForMode("implement", undefined) === true);
ok("read wait=true override", defaultWaitForMode("read", true) === true);
ok("implement wait=false override", defaultWaitForMode("implement", false) === false);

// --- pool ---
async function testPool() {
  const fakeRun = async ({ goal, mode }) => {
    const ms = mode === "read" ? 80 : 40;
    await new Promise((r) => setTimeout(r, ms));
    return `[SUBAGENT_RESULT]\nmode: ${mode}\ngoal: ${goal}\nok\n[/SUBAGENT_RESULT]`;
  };

  const pool = new SubagentPool(
    {
      client: {},
      cfg: {},
      model: "test",
      run: fakeRun,
    },
    3
  );

  const a = await pool.spawn("explore A", "read", false);
  const b = await pool.spawn("explore B", "read", false);
  ok("spawn returns running", a.status === "running" && b.status === "running");
  ok("ids distinct", a.id !== b.id);

  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 30));
  ok("main continued before subagents finished", Date.now() - t0 < 70);

  const doneA = await pool.awaitJob(a.id, 5000);
  ok("await yields done", doneA.status === "done" && /ok/.test(doneA.result || ""));

  await pool.awaitJob(b.id, 5000);
  const drained = pool.drainDone();
  ok("drainDone delivers both", drained.length === 2);
  ok("second drain empty", pool.drainDone().length === 0);

  const impl = await pool.spawn("fix X", "implement", true);
  ok("implement wait returns done", impl.status === "done");

  const p2 = new SubagentPool({ client: {}, cfg: {}, model: "t", run: fakeRun }, 3);
  const tPar = Date.now();
  const j1 = await p2.spawn("p1", "read", false);
  const j2 = await p2.spawn("p2", "read", false);
  await Promise.all([p2.awaitJob(j1.id, 5000), p2.awaitJob(j2.id, 5000)]);
  ok("parallel faster than serial 200ms", Date.now() - tPar < 200);
}

await testPool();

ok("python main.py is long-running", looksLikeLongRunningCommand("python main.py", "запуск бота"));
ok("pytest is not long-running", !looksLikeLongRunningCommand("pytest -q", "tests"));
const forced = forceBackgroundTerminalArgs({
  command: "python main.py",
  explanation: "Запускаем бота",
});
ok("auto mode=async", forced.mode === "async" && forced.isBackground === true);
ok("auto timeout capped", typeof forced.timeout === "number" && forced.timeout <= 60000);

const tid = "03885493-cd7a-4338-a2b1-9bead368d515";
ok("extract uuid", extractTerminalIds(`foo ${tid} bar`)[0] === tid);
ok("isTerminalUuid", isTerminalUuid(tid));
const tracker = new TerminalIdTracker();
tracker.rememberFromText(`terminal id: ${tid}`);
ok("tracker last", tracker.last === tid);
const fixed = tracker.rewriteCompanionArgs("get_terminal_output", { id: "not-a-uuid" });
ok("rewrite invented id", fixed.args.id === tid && !!fixed.fixed);
const okId = tracker.rewriteCompanionArgs("get_terminal_output", { id: tid });
ok("keep good id", okId.args.id === tid && !okId.fixed);
ok("bot needs desktop e2e", needsDesktopE2eVerify("создай тг бота и проверь"));
ok("plain file no desktop e2e", !needsDesktopE2eVerify("создай файл readme"));

const {
  checkDesktopActionSafety,
  isQuitKeyChord,
  isProtectedProcessName,
} = require(path.join(out, "tools", "desktopSafety.js"));
const { validateTerminalCommand } = require(path.join(out, "tools", "nativeTerminalBridge.js"));

ok("telegram process protected", isProtectedProcessName("Telegram"));
ok("Alt+F4 is quit chord", isQuitKeyChord("%{F4}"));
ok("Enter not quit", !isQuitKeyChord("{ENTER}"));
ok(
  "close telegram refused",
  /REFUSED/i.test(checkDesktopActionSafety({ action: "close", process: "Telegram" }) || "")
);
ok(
  "keys Alt+F4 refused",
  /REFUSED/i.test(
    checkDesktopActionSafety({ action: "keys", process: "Telegram", keys: "%{F4}" }) || ""
  )
);
ok(
  "unscoped keys refused",
  /REFUSED/i.test(checkDesktopActionSafety({ action: "keys", keys: "{ENTER}" }) || "")
);
ok(
  "scoped enter on telegram allowed",
  checkDesktopActionSafety({
    action: "keys",
    process: "Telegram",
    keys: "{ENTER}",
  }) === null
);
ok("empty terminal cmd refused", /empty/i.test(validateTerminalCommand("") || ""));
ok("python main.py cmd ok", validateTerminalCommand("python main.py") === null);

ok(
  "PS prompt is empty chrome",
  isEmptyTerminalOutput("PS E:\\Work\\my_project> ")
);
ok(
  "bot ready log is not empty",
  !isEmptyTerminalOutput("PS E:\\Work\\my_project> \nVulnerability Hunter Bot is ready!\n")
);
ok(
  "strip keeps bot log",
  /ready/i.test(stripShellChrome("PS E:\\Work\\my_project>\nBot is ready!\n"))
);
const emptyBot = diagnoseBotTerminalLaunch({
  command: "python main.py",
  why: "запуск бота",
  outputBlob: "Ran `python main.py`\nPS E:\\Work\\my_project>",
  exitCode: 0,
  background: false,
});
ok("empty bot sync flagged", emptyBot.deadExit && /EMPTY_OUTPUT/i.test(emptyBot.hint || ""));
const pollEmpty = diagnoseBotTerminalLaunch({
  command: "python main.py",
  outputBlob: "PS E:\\Work\\my_project>",
  isPoll: true,
  background: true,
});
ok("empty bot poll flagged", pollEmpty.deadExit && !!pollEmpty.hint);
const bgAck = diagnoseBotTerminalLaunch({
  command: "python main.py",
  outputBlob: "continues running\nisBackground=true\nterminal_id: 03885493-cd7a-4338-a2b1-9bead368d515",
  background: true,
  isPoll: false,
});
ok("bg ack without logs ok for now", !bgAck.deadExit);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll orchestrate checks passed");
