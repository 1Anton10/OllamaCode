/**
 * Keep workbench out/ in sync with src/ for OllamaCode-patched modules.
 * VSCODE_DEV loads from out/ — editing only src/ then restarting looks like
 * "patches didn't apply".
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

function resolveOss() {
  const preferred = path.join(root, ".cache", "vscode-140");
  const legacy = path.join(root, ".cache", "vscode");
  if (fs.existsSync(path.join(preferred, "package.json"))) return preferred;
  return legacy;
}

/** Relative to OSS src/ — TypeScript modules we maintain by hand. */
const TS_MODULES = [
  "vs/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerConfiguration.ts",
  "vs/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerWidget.ts",
  "vs/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerItemPrimitives.ts",
  "vs/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerItemSections.ts",
  "vs/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerPresentation.ts",
  "vs/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerActionItem.ts",
  "vs/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerTabbedWidget.ts",
  "vs/workbench/contrib/chat/browser/chatStatus/chatStatusDashboard.ts",
  "vs/workbench/contrib/chat/browser/widget/input/modelPicker/modelProviderIcons.ts",
  "vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts",
  "vs/workbench/api/browser/mainThreadChatAgents2.ts",
  "vs/workbench/contrib/chat/browser/widget/chatContentMarkdownRenderer.ts",
  "vs/workbench/services/extensions/electron-browser/localProcessExtensionHost.ts",
  "vs/platform/cssDev/node/cssDevService.ts",
  "vs/code/electron-browser/workbench/workbench.ts",
];

/** Relative to OSS src/ — copied as-is into out/ (css, svg, png). */
const ASSET_COPIES = [
  "vs/workbench/contrib/chat/browser/widget/input/modelPicker/media/modelPicker.css",
  "vs/workbench/contrib/chat/browser/widget/input/modelPicker/media/ollama-mark.svg",
  "vs/workbench/contrib/chat/browser/widget/input/modelPicker/media/ollamacode-brand-48.png",
  "vs/workbench/contrib/chat/browser/widget/media/chat.css",
  "vs/workbench/browser/parts/titlebar/media/titlebarpart.css",
  "vs/workbench/browser/media/code-icon.svg",
  "vs/workbench/browser/media/code-icon.png",
];

function hash(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function copyIfChanged(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && hash(src) === hash(dest)) return false;
  fs.copyFileSync(src, dest);
  try {
    const st = fs.statSync(src);
    fs.utimesSync(dest, st.atime, st.mtime);
  } catch {
    /* ignore */
  }
  return true;
}

function transpileTs(oss, relTs) {
  const tsPath = path.join(oss, "src", relTs);
  const jsPath = path.join(oss, "out", relTs.replace(/\.ts$/, ".js"));
  if (!fs.existsSync(tsPath)) {
    console.log("· skip missing " + relTs);
    return false;
  }
  // Skip transpile if out is already newer-or-equal AND we have a stamp matching src hash
  const stampPath = jsPath + ".ollamacode-srcsha";
  const srcSha = hash(tsPath);
  if (fs.existsSync(jsPath) && fs.existsSync(stampPath) && fs.readFileSync(stampPath, "utf8") === srcSha) {
    return false;
  }
  let ts;
  try {
    ts = require(path.join(oss, "node_modules", "typescript"));
  } catch {
    try {
      ts = require("typescript");
    } catch {
      console.warn("⚠ typescript not found — cannot transpile " + relTs);
      return false;
    }
  }
  const src = fs.readFileSync(tsPath, "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      experimentalDecorators: true,
      useDefineForClassFields: false,
      esModuleInterop: true,
      skipLibCheck: true,
      sourceMap: false,
    },
    fileName: tsPath,
  });
  fs.mkdirSync(path.dirname(jsPath), { recursive: true });
  fs.writeFileSync(jsPath, out.outputText);
  fs.writeFileSync(stampPath, srcSha);
  console.log("✓ transpile " + relTs);
  return true;
}

function main() {
  const oss = resolveOss();
  let n = 0;
  for (const rel of TS_MODULES) {
    if (transpileTs(oss, rel)) n++;
  }
  for (const rel of ASSET_COPIES) {
    const src = path.join(oss, "src", rel);
    const dest = path.join(oss, "out", rel);
    // brand PNG may live under ide/brand — titlebar patch already copies into src media
    if (copyIfChanged(src, dest)) {
      console.log("✓ asset " + rel);
      n++;
    }
  }
  // Also mirror brand icon into workbench media if present at repo root
  const brandPng = [
    path.join(root, "ide", "brand", "code-icon-1024.png"),
    path.join(root, "ollamacode-icon.png"),
  ].find((p) => fs.existsSync(p));
  if (brandPng) {
    for (const dir of ["src", "out"]) {
      const dest = path.join(oss, dir, "vs/workbench/browser/media/code-icon.png");
      if (copyIfChanged(brandPng, dest)) {
        console.log("✓ brand → " + dir + "/.../code-icon.png");
        n++;
      }
    }
  }
  if (!n) console.log("· workbench out/ already synced");
  else console.log(`✓ workbench sync (${n} updates)`);
}

main();
