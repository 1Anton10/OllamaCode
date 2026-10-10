/**
 * Ensure node-pty has conpty.dll + OpenConsole.exe under build/Release/conpty/.
 * Needed after rebuild-from-source when post-install.js did not run.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function resolveOss() {
  const preferred = path.join(root, ".cache", "vscode-140");
  const legacy = path.join(root, ".cache", "vscode");
  if (fs.existsSync(path.join(preferred, "package.json"))) return preferred;
  return legacy;
}

const oss = resolveOss();
const ptyRoot = path.join(oss, "node_modules", "node-pty");
const releaseDir = path.join(ptyRoot, "build", "Release");
const dest = path.join(releaseDir, "conpty");
const dll = path.join(dest, "conpty.dll");

if (!fs.existsSync(ptyRoot)) {
  console.warn("node-pty not installed — skip");
  process.exit(0);
}

if (fs.existsSync(dll)) {
  console.log("· conpty.dll ok");
  process.exit(0);
}

const arch = process.env.npm_config_arch || os.arch();
const candidates = [
  path.join(ptyRoot, "prebuilds", `win32-${arch}`, "conpty"),
  path.join(ptyRoot, "third_party", "conpty"),
];

let srcDir = null;
for (const c of candidates) {
  if (fs.existsSync(path.join(c, "conpty.dll"))) {
    srcDir = c;
    break;
  }
  if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
    // third_party/conpty/<version>/win10-x64
    for (const ver of fs.readdirSync(c)) {
      const nested = path.join(c, ver, `win10-${arch}`);
      if (fs.existsSync(path.join(nested, "conpty.dll"))) {
        srcDir = nested;
        break;
      }
    }
  }
  if (srcDir) break;
}

if (!srcDir) {
  console.warn("conpty.dll source not found under node-pty");
  process.exit(0);
}

fs.mkdirSync(dest, { recursive: true });
for (const file of ["conpty.dll", "OpenConsole.exe"]) {
  const from = path.join(srcDir, file);
  if (!fs.existsSync(from)) continue;
  fs.copyFileSync(from, path.join(dest, file));
  console.log(`✓ ${file} → ${dest}`);
}
