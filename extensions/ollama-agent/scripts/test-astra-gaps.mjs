/**
 * Smoke: Astra gap tools (web_search parse + parser defs) without VS Code host.
 * Run: node scripts/test-astra-gaps.mjs
 */
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

// Compile check: import built JS if present, else transpile-free unit of webSearch via dynamic
async function main() {
  const outWeb = path.join(root, "out", "tools", "webSearch.js");
  const outParser = path.join(root, "out", "tools", "parser.js");
  if (!fs.existsSync(outWeb) || !fs.existsSync(outParser)) {
    console.error("FAIL: build out/ first (npm run compile)");
    process.exit(1);
  }

  const { runWebSearch, formatWebSearchHits, parseDdgHtml } = (() => {
    const m = require(outWeb);
    return m;
  })();
  const { TOOL_DEFINITIONS, parseToolCalls } = require(outParser);

  const names = TOOL_DEFINITIONS.map((d) => d.function?.name).filter(Boolean);
  for (const n of ["web_search", "await_terminal", "delete_file"]) {
    if (!names.includes(n)) {
      console.error("FAIL: missing TOOL_DEFINITIONS", n);
      process.exit(1);
    }
  }
  console.log("OK TOOL_DEFINITIONS include web_search, await_terminal, delete_file");

  // Do not ship local browser/fetch clones
  for (const bad of ["open_browser_page", "fetch_webpage", "vscode_fetchWebPage_internal", "browser_navigate"]) {
    if (names.includes(bad)) {
      console.error("FAIL: must not redefine native tool", bad);
      process.exit(1);
    }
  }
  console.log("OK no local browser/fetch clones in TOOL_DEFINITIONS");

  const xml = parseToolCalls(
    `<web_search><query>ollama tools</query><max_results>3</max_results></web_search>`,
    { allowJson: true, allowXml: true }
  );
  if (xml.length !== 1 || xml[0].name !== "web_search" || xml[0].arguments.query !== "ollama tools") {
    console.error("FAIL xml parse", xml);
    process.exit(1);
  }
  console.log("OK XML web_search parse");

  const del = parseToolCalls(`{"name":"delete_file","arguments":{"path":"tmp.txt"}}`, {
    allowJson: true,
    allowXml: true,
  });
  if (!del.some((c) => c.name === "delete_file")) {
    console.error("FAIL delete_file json", del);
    process.exit(1);
  }
  console.log("OK JSON delete_file parse");

  const awaitXml = parseToolCalls(
    `<await_terminal><id>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</id><pattern>ready</pattern><timeout_ms>5000</timeout_ms></await_terminal>`,
    { allowJson: true, allowXml: true }
  );
  if (awaitXml[0]?.name !== "await_terminal" || awaitXml[0]?.arguments?.pattern !== "ready") {
    console.error("FAIL await_terminal xml", awaitXml);
    process.exit(1);
  }
  console.log("OK XML await_terminal parse");

  // Live search (network) — soft fail if blocked
  try {
    const res = await runWebSearch("TypeScript 5.0 release notes", 3);
    if (!res.ok) {
      console.warn("WARN web_search network:", res.error);
    } else {
      console.log("OK web_search hits=", res.hits.length, "source=", res.source);
      console.log(formatWebSearchHits(res.hits, res.source).slice(0, 400));
    }
  } catch (e) {
    console.warn("WARN web_search threw:", e?.message || e);
  }

  // Static HTML parse if exported — optional
  if (typeof parseDdgHtml === "function") {
    const sample = `<a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example Title</a><a class="result__snippet">Hello snippet</a>`;
    const hits = parseDdgHtml(sample, 5);
    console.log("OK parseDdgHtml sample hits=", hits.length);
  }

  console.log("ALL SMOKE PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
