import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
const require = createRequire(import.meta.url);
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "out");
const {
  parseToolCalls,
  parseToolCallsFromTurn,
  hasIncompleteToolMarkup,
  stripToolMarkup,
} = require(path.join(outDir, "tools", "parser.js"));

const samples = [
  `<tool_call>
<function=list_files>
<parameter=path>
C:\\Users\\gordo\\.openclaw\\cursor-local\\resources\\app\\extensions\\cursor-agent-host
</parameter>
</function>
</tool_call>`,
  `Key insight about Cursor.
<tool_call>
<function=list_files>
<parameter=path> C:\\Users\\gordo\\.openclaw\\cursor-local\\resources\\app\\extensions\\cursor-agent-host </parameter>
</function>
</tool_call>`,
  `<function=list_files>
<parameter=path>
C:\\Users\\gordo\\.openclaw\\cursor-local\\resources\\app\\extensions\\cursor-agent-host
</parameter>
</function>`,
  // self-closing / weird spacing
  `<tool_call><function=list_files><parameter=path>C:/Users/gordo/.openclaw/cursor-local</parameter></function></tool_call>`,
];

let fail = 0;
for (let i = 0; i < samples.length; i++) {
  const c = parseToolCalls(samples[i], { allowJson: true, allowXml: true });
  const ok = c.length === 1 && c[0].name === "list_files" && String(c[0].arguments.path || "").includes("openclaw");
  console.log(i, ok ? "OK" : "FAIL", c.map((x) => ({ n: x.name, path: x.arguments?.path })));
  if (!ok) fail++;
  const stripped = stripToolMarkup(samples[i]);
  if (/tool_call|function=/i.test(stripped)) {
    console.log(i, "STRIP FAIL", JSON.stringify(stripped.slice(0, 120)));
    fail++;
  }
}
{
  const thinking = `Сначала list_files.\n${samples[0]}`;
  const fromThink = parseToolCallsFromTurn("", thinking, { allowJson: true, allowXml: true });
  const ok = fromThink.length === 1 && fromThink[0].name === "list_files";
  console.log("from thinking", ok ? "OK" : "FAIL", fromThink.map((x) => x.name));
  if (!ok) fail++;
}
{
  const incomplete = "<tool_call>\n<function=list_files>\n<parameter=path>\nC:\\x";
  console.log(
    "incomplete",
    hasIncompleteToolMarkup(incomplete) ? "OK" : "FAIL"
  );
  if (!hasIncompleteToolMarkup(incomplete)) fail++;
  if (hasIncompleteToolMarkup(samples[0])) {
    console.log("complete marked incomplete FAIL");
    fail++;
  }
}
process.exit(fail ? 1 : 0);
