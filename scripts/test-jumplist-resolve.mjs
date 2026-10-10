import fs from "fs";
import path from "path";

const defaults = JSON.parse(
  fs.readFileSync(
    "E:/Work/OllamaCode/.cache/vscode-140/.build/electron/ollamacode-defaults.json",
    "utf8"
  )
);
const roots = defaults.workRoots || [];

function resolveOpen(p) {
  const raw = String(p || "")
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!raw) return null;
  const leaf = path.basename(raw.replace(/[\\/]+$/, ""));
  const candidates = [
    path.resolve(raw),
    path.resolve(defaults.oss, raw),
    path.resolve(defaults.oss, "..", "..", raw),
    path.join("E:\\Work", leaf),
    path.join("D:\\Work", leaf),
    path.join("E:\\Work", "OllamaCode", ".cache", leaf),
    path.join(defaults.oss, ".cache", leaf),
    defaults.workspace,
    ...roots.map((r) => path.join(r, leaf)),
    ...roots.map((r) => path.join(r, raw)),
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return fs.realpathSync(c);
    } catch {
      /* continue */
    }
  }
  // workspace display name → *.code-workspace
  if (/workspace/i.test(raw) || /ollamacode/i.test(raw)) {
    if (defaults.workspace && fs.existsSync(defaults.workspace)) return defaults.workspace;
  }
  return null;
}

const tests = [
  "my_project",
  "E:\\Work\\my_project",
  "vscode-140",
  "cursor",
  "OllamaCode (Workspace)",
  "E:\\Work\\OllamaCode\\OllamaCode.code-workspace",
];
for (const p of tests) {
  console.log(JSON.stringify(p), "->", resolveOpen(p));
}
