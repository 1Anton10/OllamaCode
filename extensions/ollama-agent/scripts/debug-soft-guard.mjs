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
    return { workspace: { getConfiguration: () => ({ get: () => undefined }) } };
  }
  return orig.apply(this, arguments);
};

const { SoftThinkingGuard, textSimilarity } = require("../out/agent/loopGuards.js");
const sample = fs.readFileSync(path.join(__dirname, "fixtures/comfort-thinking-sample.txt"), "utf8");

const g = new SoftThinkingGuard();
let firstMuteAt = -1;
let emitted = 0;
for (let i = 40; i <= sample.length; i += 20) {
  const v = g.filter(sample.slice(0, i));
  if (v.emitDelta) emitted += v.emitDelta.length;
  if (v.reason && firstMuteAt < 0) {
    firstMuteAt = i;
    console.log("first mute at", i, v.reason);
    console.log("tail:", JSON.stringify(sample.slice(Math.max(0, i - 120), i)));
  }
}
console.log("emitted", emitted, "ratio", (emitted / sample.length).toFixed(2), "firstMute", firstMuteAt);

// Find second Пользователь
const idx = sample.indexOf("Пользователь спрашивает, комфортно");
console.log("second opener idx", idx);
const a = sample.slice(0, 90);
const b = sample.slice(idx, idx + 90);
console.log("sim stems", textSimilarity(a, b).toFixed(3));
