/**
 * Content-accurate sync of ollama-agent → OSS builtin extensions/.
 * Robocopy /XO was skipping updates when the destination mtime was newer
 * (common after hand-edits / failed partial syncs) — launch then looked
 * like "our patches didn't stick".
 *
 * Usage: node scripts/sync-ollama-agent.mjs [--bump]
 *   --bump  increment package.json patch when any file was written
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function resolveOss() {
  const preferred = path.join(root, ".cache", "vscode-140");
  const legacy = path.join(root, ".cache", "vscode");
  if (fs.existsSync(path.join(preferred, "package.json"))) return preferred;
  return legacy;
}

function hashFile(p) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(p));
  return h.digest("hex");
}

function shouldSkipDir(name) {
  return name === "node_modules" || name === ".git" || name === ".DS_Store";
}

/**
 * Recursively copy src → dest when content differs (or dest missing).
 * Returns number of files written.
 */
export function syncDirByContent(srcDir, destDir) {
  let written = 0;
  if (!fs.existsSync(srcDir)) return 0;
  fs.mkdirSync(destDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (shouldSkipDir(ent.name)) continue;
    const s = path.join(srcDir, ent.name);
    const d = path.join(destDir, ent.name);
    if (ent.isDirectory()) {
      written += syncDirByContent(s, d);
      continue;
    }
    if (!ent.isFile()) continue;
    let need = !fs.existsSync(d);
    if (!need) {
      try {
        const a = fs.statSync(s);
        const b = fs.statSync(d);
        if (a.size !== b.size) need = true;
        else if (hashFile(s) !== hashFile(d)) need = true;
      } catch {
        need = true;
      }
    }
    if (need) {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      let buf = fs.readFileSync(s);
      // VS Code extension scanner rejects package.json with UTF-8 BOM
      if (
        ent.name === "package.json" &&
        buf.length >= 3 &&
        buf[0] === 0xef &&
        buf[1] === 0xbb &&
        buf[2] === 0xbf
      ) {
        buf = buf.subarray(3);
      }
      fs.writeFileSync(d, buf);
      try {
        const st = fs.statSync(s);
        fs.utimesSync(d, st.atime, st.mtime);
      } catch {
        /* ignore */
      }
      written++;
    }
  }
  return written;
}

function bumpPatchVersion(pkgPath) {
  let raw = fs.readFileSync(pkgPath, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const pkg = JSON.parse(raw);
  const m = String(pkg.version || "0.0.0").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
  pkg.version = next;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  return next;
}

export function syncOllamaAgent(opts = {}) {
  const oss = resolveOss();
  const src = path.join(root, "extensions", "ollama-agent");
  const dest = path.join(oss, "extensions", "ollama-agent");
  if (!fs.existsSync(path.join(src, "package.json"))) {
    throw new Error("extensions/ollama-agent missing");
  }
  const written = syncDirByContent(src, dest);
  const readJson = (p) => {
    let raw = fs.readFileSync(p, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  };
  let version = readJson(path.join(dest, "package.json")).version;
  if (written > 0 && opts.bump) {
    const bumped = bumpPatchVersion(path.join(src, "package.json"));
    if (bumped) {
      fs.copyFileSync(path.join(src, "package.json"), path.join(dest, "package.json"));
      version = bumped;
    }
  }
  return { written, version, dest, oss };
}

function main() {
  const bump = process.argv.includes("--bump");
  const { written, version } = syncOllamaAgent({ bump });
  if (written > 0) {
    console.log(`✓ ollama-agent synced (${written} files) v${version}`);
  } else {
    console.log(`· ollama-agent already in sync (v${version})`);
  }
}

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (isDirect) {
  main();
}