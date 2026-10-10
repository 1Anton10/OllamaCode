/**
 * Patch chatContextUsageWidget inside workbench.desktop.main.js
 * so Session Info doesn't stick at 0% when stream.usage was dropped.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const file = path.join(root, ".cache/vscode-140/out/vs/workbench/workbench.desktop.main.js");

let s = fs.readFileSync(file, "utf8");
if (s.includes("OLLAMACODE_USAGE_FALLBACK")) {
  console.log("· usage-fallback already in workbench.desktop.main.js");
  process.exit(0);
}

const old = `if (!usage || !contextWindow) {
      if (!this._currentData.get()) {
        this._showEmptyRingForSelectedModel();
      }
      return;
    }
    const { maxOutputTokens, totalContextWindow } = contextWindow;
    const promptTokens = usage.promptTokens;
    const completionTokens = usage.completionTokens;`;

const neu = `if (!contextWindow) {
      if (!this._currentData.get()) {
        this._showEmptyRingForSelectedModel();
      }
      return;
    }
    // OLLAMACODE_USAGE_FALLBACK
    if (!usage) {
      const req = response.session.getRequests().find((r) => r.id === response.requestId);
      const chars = (req?.message.text?.length ?? 0) + (response.response.toString().length ?? 0);
      const est = Math.max(1, Math.ceil(chars / 4));
      usage = { kind: "usage", promptTokens: est, completionTokens: 0 };
    }
    const { maxOutputTokens, totalContextWindow } = contextWindow;
    const promptTokens = usage.promptTokens;
    const completionTokens = usage.completionTokens;`;

if (!s.includes(old)) {
  // try looser match around unique neighbor
  const idx = s.indexOf("const { maxOutputTokens, totalContextWindow } = contextWindow;");
  console.error("⚠ usage-fallback block not found, idx of destructure", idx);
  const nearby = s.indexOf("if (!usage || !contextWindow)");
  console.error("nearby if", nearby);
  if (nearby >= 0) console.error(s.slice(nearby, nearby + 280));
  process.exit(1);
}

s = s.replace(old, neu);
fs.writeFileSync(file, s);
console.log("✓ OLLAMACODE_USAGE_FALLBACK → workbench.desktop.main.js");
