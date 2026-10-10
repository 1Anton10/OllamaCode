/**
 * Electron entry when OllamaCode.exe is started without an app root
 * (taskbar jump list / pin). Relays into Code-OSS with launch.ps1 flags
 * so Windows never shows a blank "Electron" window.
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const electronDir = path.dirname(process.execPath);
const defaultsPath = path.join(electronDir, "ollamacode-defaults.json");
const logPath = path.join(electronDir, "ollamacode-shim.log");

function log(msg) {
  try {
    fs.appendFileSync(logPath, new Date().toISOString() + " " + msg + "\n");
  } catch {
    /* ignore */
  }
}

function loadDefaults() {
  const ossGuess = path.resolve(electronDir, "..", "..");
  const rootGuess = path.resolve(ossGuess, "..", "..");
  const defaults = {
    oss: ossGuess,
    userData: path.join(rootGuess, ".userdata-oss"),
    workspace: path.join(rootGuess, "OllamaCode.code-workspace"),
  };
  try {
    if (fs.existsSync(defaultsPath)) {
      Object.assign(defaults, JSON.parse(fs.readFileSync(defaultsPath, "utf8")));
    }
  } catch (e) {
    log("defaults parse: " + e);
  }
  return defaults;
}

const defaults = loadDefaults();
const raw = process.argv.slice(1).filter((a) => {
  if (!a || a === ".") return false;
  const norm = String(a).replace(/\//g, "\\").toLowerCase();
  if (norm.includes("\\resources\\app")) return false;
  if (norm.includes("default_app")) return false;
  return true;
});

// If launch.ps1 flags are already present, we should not be default_app.
// Bail instead of re-entering a relaunch loop.
if (raw.some((a) => String(a).startsWith("--user-data-dir"))) {
  log("refuse loop: user-data-dir already in argv");
  try {
    require("electron").app.exit(1);
  } catch {
    process.exit(1);
  }
}

const flags = raw.filter((a) => a.startsWith("-"));
const paths = raw.filter((a) => !a.startsWith("-"));

const args = [
  defaults.oss,
  "--user-data-dir=" + defaults.userData,
  "--builtin-extensions-dir=" + path.join(defaults.oss, "extensions"),
  "--extensions-dir=" + path.join(defaults.userData, "extensions"),
  "--disable-telemetry",
  "--disable-updates",
  "--disable-extension=GitHub.copilot",
  "--disable-extension=GitHub.copilot-chat",
  "--disable-extension=GitHub.copilot-nightly",
  "--disable-extension=vscode.vscode-api-tests",
  "--disable-extension=github.vscode-pull-request-github",
  "--disable-extension=ms-vscode.js-debug-companion",
  "--disable-extension=ms-vscode.vscode-js-profile-table",
].concat(flags);

if (paths.length) {
  args.push.apply(args, paths);
} else if (defaults.workspace && fs.existsSync(defaults.workspace)) {
  args.push(defaults.workspace);
}

log("shim argv=" + JSON.stringify(process.argv));
log("relay args=" + JSON.stringify(args));

// Fully detach on Windows: parent Electron job must not kill the real app.
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}
const argList = args.map(psQuote).join(",");
const ps =
  "Start-Process -FilePath " +
  psQuote(process.execPath) +
  " -WorkingDirectory " +
  psQuote(defaults.oss) +
  " -ArgumentList @(" +
  argList +
  ")";

const child = spawn(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", ps],
  {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      VSCODE_SKIP_PRELAUNCH: "1",
      VSCODE_CLI: "1",
      NODE_ENV: "production",
      NODE_OPTIONS: "",
    },
  }
);
child.unref();
log("spawned powershell pid=" + child.pid);

try {
  const { app } = require("electron");
  app.exit(0);
} catch {
  process.exit(0);
}
