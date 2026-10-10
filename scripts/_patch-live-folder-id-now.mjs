/**
 * One-shot: fix LIVE_FOLDER_PERSIST id in out-fast / out bundles.
 */
import fs from "fs";

const paths = [
  "E:/Work/OllamaCode/.cache/vscode-140/out-fast/vs/workbench/workbench.desktop.main.js",
  "E:/Work/OllamaCode/.cache/vscode-140/out/vs/workbench/workbench.desktop.main.js",
];

const oldLine = "const identifier = { id: hash(uri.toString()).toString(16), uri };";
const newBlock = `let identifier = typeof getSingleFolderWorkspaceIdentifier === "function"
      ? getSingleFolderWorkspaceIdentifier(uri)
      : { id: hash(uri.toString()).toString(16), uri };
    if (!identifier?.id) {
      identifier = { id: hash(uri.toString()).toString(16), uri };
    }`;

for (const p of paths) {
  if (!fs.existsSync(p)) {
    console.log("miss", p);
    continue;
  }
  let s = fs.readFileSync(p, "utf8");
  if (!s.includes("OLLAMACODE_LIVE_FOLDER_PERSIST")) {
    console.log("no PERSIST marker", p);
    continue;
  }
  if (s.includes("getSingleFolderWorkspaceIdentifier(uri)") && s.includes("id=${identifier.id}")) {
    console.log("already", p);
    continue;
  }
  if (!s.includes(oldLine)) {
    console.log("no old identifier line", p);
    continue;
  }
  s = s.replace(oldLine, newBlock);
  s = s.replace(
    "this.logService.info(`[OLLAMACODE_LIVE_FOLDER] ${uri.toString()}`);",
    "this.logService.info(`[OLLAMACODE_LIVE_FOLDER] ${uri.toString()} id=${identifier.id}`);"
  );
  fs.writeFileSync(p, s);
  console.log("✓", p);
}
