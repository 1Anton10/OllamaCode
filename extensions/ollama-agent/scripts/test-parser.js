const { parseToolCalls, stripToolMarkup } = require("../out/tools/parser.js");

const sample = [
  "Сейчас сделаю.",
  "<execute_command><command>dir</command></execute_command>",
  '```json',
  '{"name":"read_file","arguments":{"path":"README.md"}}',
  "```",
].join("\n");

const calls = parseToolCalls(sample, { allowJson: true, allowXml: true });
console.log(
  calls.map((c) => `${c.source}:${c.name}:${JSON.stringify(c.arguments)}`).join("\n")
);
console.log("stripped=", stripToolMarkup(sample));
