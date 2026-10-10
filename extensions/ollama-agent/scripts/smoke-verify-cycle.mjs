/**
 * Parser + edit→verify anti-loop smoke (no VS Code / no GPU required for guards).
 * Optional: OLLAMA_SMOKE=1 hits local Ollama with a tiny tool-call prompt.
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
        workspaceFolders: [{ uri: { fsPath: path.resolve(__dirname, "..") } }],
        getConfiguration: () => ({ get: () => undefined }),
      },
      window: { showInformationMessage: async () => {} },
    };
  }
  return orig.apply(this, arguments);
};

const { parseToolCalls } = require(path.join(__dirname, "../out/tools/parser.js"));
const { AgentLoopDetector } = require(path.join(__dirname, "../out/agent/loopGuards.js"));

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) console.log("  OK ", name, detail);
  else {
    failed++;
    console.error("  FAIL", name, detail);
  }
}

console.log("## parsers");
const samples = [
  { id: "json", text: `{"name":"read_file","arguments":{"path":"package.json"}}`, expect: "read_file" },
  { id: "xml", text: `<read_file><path>package.json</path></read_file>`, expect: "read_file" },
  {
    id: "fence",
    text: "```json\n{\"name\":\"grep\",\"arguments\":{\"pattern\":\"ollamaCode\"}}\n```",
    expect: "grep",
  },
  {
    id: "replace",
    text: `{"name":"replace_in_file","arguments":{"path":"a.ts","old_string":"x","new_string":"y"}}`,
    expect: "replace_in_file",
  },
];
for (const s of samples) {
  const calls = parseToolCalls(s.text, { allowJson: true, allowXml: true });
  check(s.id, calls.some((c) => c.name === s.expect), calls.map((c) => c.name).join(",") || "none");
}

console.log("## edit→verify on extension files");
const files = ["src/agent/loopGuards.ts", "src/chatParticipant.ts", "package.json"];
for (const f of files) {
  const det = new AgentLoopDetector({ maxIdenticalCalls: 3 });
  const r1 = det.record("read_file", { path: f });
  const r2 = det.record("replace_in_file", { path: f, old_string: "a", new_string: "b" });
  det.noteProgress();
  const r3 = det.record("read_file", { path: f });
  check(
    `verify ${f}`,
    !r1.blocked && !r2.blocked && !r3.blocked,
    r1.blocked || r2.blocked || r3.blocked ? "blocked" : "allowed"
  );
}

const spam = new AgentLoopDetector({ maxIdenticalCalls: 3 });
spam.record("read_file", { path: "same.ts" });
spam.record("read_file", { path: "same.ts" });
check("triple identical read blocks", spam.record("read_file", { path: "same.ts" }).blocked);

async function ollamaSmoke() {
  const model = process.env.OLLAMA_MODEL || "agent36:latest";
  const base = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const prompt =
    "Call a tool to read package.json. Reply ONLY with JSON tool call: " +
    '{"name":"read_file","arguments":{"path":"package.json"}}';
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      messages: [
        { role: "system", content: "You are a coding agent. Prefer tool_calls as JSON." },
        { role: "user", content: prompt },
      ],
      options: { num_predict: 120, temperature: 0.1, num_ctx: 4096 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data = await res.json();
  const text = data?.message?.content || "";
  const calls = parseToolCalls(text, { allowJson: true, allowXml: true });
  check(
    `ollama ${model} tool parse`,
    calls.some((c) => c.name === "read_file"),
    (calls[0]?.name || text.slice(0, 80)).toString()
  );
}

const runOllama = process.env.OLLAMA_SMOKE === "1";
(async () => {
  if (runOllama) {
    console.log("## ollama live");
    try {
      await ollamaSmoke();
    } catch (e) {
      failed++;
      console.error("  FAIL ollama", e?.message || e);
    }
  } else {
    console.log("## ollama live skipped (set OLLAMA_SMOKE=1)");
  }
  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log("\nSmoke OK");
})();
