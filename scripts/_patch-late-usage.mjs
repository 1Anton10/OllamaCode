/**
 * Patch workbench.desktop.main.js for OLLAMACODE_LATE_USAGE / USAGE_FORWARD.
 * Fat esbuild bundle is too large for editor tools — run via node.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const file = path.join(root, ".cache/vscode-140/out/vs/workbench/workbench.desktop.main.js");

if (!fs.existsSync(file)) {
  console.error("missing", file);
  process.exit(1);
}

let s = fs.readFileSync(file, "utf8");
if (s.includes("OLLAMACODE_LATE_USAGE")) {
  console.log("· late-usage already in workbench.desktop.main.js");
  process.exit(0);
}

const dropWarn = "No response model for usage of non-subagent request ${requestId}; dropping usage.";
const dropIdx = s.indexOf(dropWarn);
if (dropIdx < 0) {
  console.error("⚠ drop-usage warn not found");
  process.exit(1);
}

// Replace the else { warn drop } branch with forward-to-progress
const elseDropRe =
  /else \{\s*this\._logService\.warn\(`MainThreadChatAgents2#\$handleProgressChunk: No response model for usage of non-subagent request \$\{requestId\}; dropping usage\.`\);\s*\}/;
if (!elseDropRe.test(s)) {
  console.error("⚠ else-drop block shape changed");
  process.exit(1);
}
s = s.replace(
  elseDropRe,
  `else {
          // OLLAMACODE_USAGE_FORWARD
          chatProgressParts.push({
            kind: "usage",
            promptTokens: progress2.promptTokens,
            completionTokens: progress2.completionTokens,
            outputBuffer: progress2.outputBuffer,
            copilotCredits: progress2.copilotCredits,
            promptTokenDetails: progress2.promptTokenDetails
          });
        }`
);

const pendingNeedle =
  "this._logService.warn(`MainThreadChatAgents2#$handleProgressChunk: No pending progress for requestId ${requestId}`);\n      return;\n    }\n    const { progress, chatSession, isSubagent } = pendingProgress;\n    const chatProgressParts = [];\n    const response = chatSession?.getRequests().find((req) => req.id === requestId)?.response;";

const pendingReplacement = `// OLLAMACODE_LATE_USAGE — apply usage even after invoke cleared pendingProgress
      let appliedLate = 0;
      for (const item of chunks) {
        const progressLate = Array.isArray(item) ? item[0] : item;
        if (progressLate.kind !== "usage") continue;
        let responseLate;
        for (const widget of this._chatWidgetService.getAllWidgets()) {
          responseLate = widget.viewModel?.model?.getRequests().find((req) => req.id === requestId)?.response;
          if (responseLate) break;
        }
        if (!responseLate) {
          responseLate = this._chatWidgetService.lastFocusedWidget?.viewModel?.model?.getRequests().find((req) => req.id === requestId)?.response;
        }
        if (responseLate) {
          responseLate.setUsage({
            kind: "usage",
            promptTokens: progressLate.promptTokens,
            completionTokens: progressLate.completionTokens,
            outputBuffer: progressLate.outputBuffer,
            copilotCredits: progressLate.copilotCredits,
            promptTokenDetails: progressLate.promptTokenDetails
          });
          appliedLate++;
        }
      }
      if (appliedLate === 0) {
        this._logService.warn(\`MainThreadChatAgents2#$handleProgressChunk: No pending progress for requestId \${requestId}\`);
      }
      return;
    }
    const { progress, chatSession, isSubagent } = pendingProgress;
    const chatProgressParts = [];
    let response = chatSession?.getRequests().find((req) => req.id === requestId)?.response;
    if (!response) {
      for (const widget of this._chatWidgetService.getAllWidgets()) {
        response = widget.viewModel?.model?.getRequests().find((req) => req.id === requestId)?.response;
        if (response) break;
      }
    }`;

if (!s.includes(pendingNeedle)) {
  console.error("⚠ pending-progress block shape changed");
  process.exit(1);
}
s = s.replace(pendingNeedle, pendingReplacement);

fs.writeFileSync(file, s);
console.log("✓ OLLAMACODE_LATE_USAGE → workbench.desktop.main.js");
