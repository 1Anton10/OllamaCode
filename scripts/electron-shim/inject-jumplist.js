/**
 * Injected into Electron resources/default_app.asar main.js (after imports).
 * Rewrites bare jump-list launches:
 *   OllamaCode.exe E:\Work\my_project
 * into a full Code-OSS boot (same flags as scripts/launch.ps1).
 */
import fs from "node:fs";
import path from "node:path";

(function ollamaCodeJumpListShim() {
  try {
    const electronDir = path.dirname(process.execPath);
    const defaultsPath = path.join(electronDir, "ollamacode-defaults.json");
    if (!fs.existsSync(defaultsPath)) return;
    const defaults = JSON.parse(fs.readFileSync(defaultsPath, "utf8"));
    if (!defaults?.oss || !fs.existsSync(path.join(defaults.oss, "package.json"))) return;

    const args = process.argv.slice(1);
    if (args.some((a) => String(a).startsWith("--user-data-dir"))) return;

    const positional = args.filter((a) => a && !String(a).startsWith("-"));
    const flags = args.filter((a) => a && String(a).startsWith("-"));
    const first = positional[0];
    const firstIsApp =
      first &&
      fs.existsSync(path.join(path.resolve(first), "package.json")) &&
      (() => {
        try {
          const j = JSON.parse(
            fs.readFileSync(path.join(path.resolve(first), "package.json"), "utf8")
          );
          return typeof j.main === "string" && String(j.main).includes("main");
        } catch {
          return false;
        }
      })();

    // launch.ps1 already passes "." / OSS root — leave alone
    if (firstIsApp) return;

    process.env.VSCODE_SKIP_PRELAUNCH = process.env.VSCODE_SKIP_PRELAUNCH || "1";
    process.env.VSCODE_CLI = process.env.VSCODE_CLI || "1";
    if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";

    const openPaths =
      positional.length > 0
        ? positional
        : defaults.workspace && fs.existsSync(defaults.workspace)
          ? [defaults.workspace]
          : [];

    process.argv = [
      process.argv[0],
      defaults.oss,
      `--user-data-dir=${defaults.userData}`,
      `--builtin-extensions-dir=${path.join(defaults.oss, "extensions")}`,
      `--extensions-dir=${path.join(defaults.userData, "extensions")}`,
      "--disable-telemetry",
      "--disable-updates",
      "--disable-extension=GitHub.copilot",
      "--disable-extension=GitHub.copilot-chat",
      "--disable-extension=GitHub.copilot-nightly",
      "--disable-extension=vscode.vscode-api-tests",
      "--disable-extension=github.vscode-pull-request-github",
      "--disable-extension=ms-vscode.js-debug-companion",
      "--disable-extension=ms-vscode.vscode-js-profile-table",
      ...flags,
      ...openPaths,
    ];
  } catch {
    /* never block Electron boot */
  }
})();
