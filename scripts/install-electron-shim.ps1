# Patch Electron default_app.asar so taskbar jump-list opens folders in Code-OSS
# (not a blank window / empty text tab). Keeps stock loader; injects argv rewrite.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "_oss-path.ps1")
$oss = Get-OllamaCodeOssRoot $root
$electronDir = Join-Path $oss ".build\electron"
$res = Join-Path $electronDir "resources"
$exe = Join-Path $electronDir "OllamaCode.exe"
if (-not (Test-Path $exe)) { throw "Missing $exe - run electron download first" }

foreach ($bad in @("app", "app.off")) {
  $p = Join-Path $res $bad
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}

$asar = Join-Path $res "default_app.asar"
$stock = Join-Path $res "default_app.asar.stock"
if (-not (Test-Path $stock)) {
  if (-not (Test-Path $asar)) { throw "Missing $asar" }
  Copy-Item $asar $stock -Force
}

$asarBin = @(
  (Join-Path $oss "node_modules\asar\bin\asar.js"),
  (Join-Path $oss "node_modules\@electron\asar\bin\asar.js")
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $asarBin) { throw "asar CLI not found under OSS node_modules" }

$stage = Join-Path $env:TEMP "ollamacode-default-app-stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
& node $asarBin extract $stock $stage
if ($LASTEXITCODE -ne 0) { throw "asar extract failed" }

$mainPath = Join-Path $stage "main.js"
$main = [System.IO.File]::ReadAllText($mainPath)
$marker = "// Parse command line options."
if ($main -notmatch [regex]::Escape($marker)) {
  throw "default_app main.js marker not found - Electron version changed?"
}

# Strip any prior shim versions
$main = $main -replace '(?s)/\* OLLAMACODE_JUMPLIST_SHIM(_V\d+)?[\s\S]*?\}\)\(\);\r?\n\r?\n', ''

$block = @'

/* OLLAMACODE_JUMPLIST_SHIM_V4 */
(function ollamaCodeJumpListShim() {
  const logPath = path.join(path.dirname(process.execPath), "jumplist.log");
  function jlog(msg) {
    try {
      fs.appendFileSync(
        logPath,
        new Date().toISOString() + " " + msg + "\n",
        "utf8"
      );
    } catch { /* ignore */ }
  }
  try {
    const electronDir = path.dirname(process.execPath);
    const defaultsPath = path.join(electronDir, "ollamacode-defaults.json");
    if (!fs.existsSync(defaultsPath)) return;
    const defaults = JSON.parse(fs.readFileSync(defaultsPath, "utf8"));
    if (!defaults?.oss || !fs.existsSync(path.join(defaults.oss, "package.json"))) return;
    const argsIn = process.argv.slice(1);
    jlog("argv_in=" + JSON.stringify(argsIn));
    // launch.ps1 already built a full argv — leave alone
    if (argsIn.some((a) => String(a).startsWith("--user-data-dir"))) return;

    const positional = argsIn.filter((a) => a && !String(a).startsWith("-"));
    const flags = argsIn.filter((a) => a && String(a).startsWith("-"));

    let firstIsOssApp = false;
    if (positional[0]) {
      try {
        const resolved = path.resolve(String(positional[0]).replace(/^["']|["']$/g, ""));
        const ossReal = fs.realpathSync(defaults.oss);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
          firstIsOssApp = fs.realpathSync(resolved) === ossReal;
        }
      } catch { firstIsOssApp = false; }
    }
    if (firstIsOssApp) return;

    process.env.VSCODE_SKIP_PRELAUNCH = process.env.VSCODE_SKIP_PRELAUNCH || "1";
    process.env.VSCODE_CLI = process.env.VSCODE_CLI || "1";
    if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";
    try { process.chdir(defaults.oss); } catch { /* ignore */ }

    const roots = Array.isArray(defaults.workRoots) && defaults.workRoots.length
      ? defaults.workRoots
      : ["E:\\Work", "D:\\Work", path.join(process.env.USERPROFILE || "", "Projects"), process.env.USERPROFILE || ""];

    function stripQuotes(s) {
      return String(s || "").trim().replace(/^["']|["']$/g, "").replace(/^\\\\?\\/, "");
    }
    function fromFileUri(p) {
      const s = stripQuotes(p);
      if (/^file:/i.test(s)) {
        try { return url.fileURLToPath(s); } catch { return null; }
      }
      return s;
    }
    function resolveOpen(p) {
      const raw = fromFileUri(p);
      if (!raw) return null;
      const leaf = path.basename(String(raw).replace(/[\\/]+$/, ""));
      const repoRoot = path.resolve(defaults.oss, "..", "..");
      const candidates = [
        path.resolve(raw),
        path.resolve(defaults.oss, raw),
        path.resolve(repoRoot, raw),
        path.join("E:\\Work", leaf),
        path.join("D:\\Work", leaf),
        path.join(defaults.oss, ".cache", leaf),
        path.join(repoRoot, ".cache", leaf),
        defaults.workspace,
        ...roots.filter(Boolean).map((r) => path.join(r, leaf)),
        ...roots.filter(Boolean).map((r) => path.join(r, raw)),
      ];
      if (/workspace/i.test(raw) || /ollamacode/i.test(raw)) {
        if (defaults.workspace && fs.existsSync(defaults.workspace)) {
          candidates.unshift(defaults.workspace);
        }
      }
      for (const c of candidates) {
        try {
          if (c && fs.existsSync(c)) return fs.realpathSync(c);
        } catch { /* continue */ }
      }
      return null;
    }

    const openArgs = [];
    for (const p of positional) {
      const abs = resolveOpen(p);
      if (!abs) {
        jlog("resolve_miss=" + JSON.stringify(p));
        continue;
      }
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        openArgs.push("--folder-uri=" + url.pathToFileURL(abs).href);
      } else if (/\.code-workspace$/i.test(abs)) {
        openArgs.push(abs);
      } else {
        openArgs.push("--file-uri=" + url.pathToFileURL(abs).href);
      }
    }

    const windowMode =
      openArgs.length > 0 ? ["--new-window", ...openArgs] : ["--reuse-window"];

    process.argv = [
      process.argv[0],
      ".",
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
      ...flags,
      ...windowMode,
    ];
    jlog("argv_out=" + JSON.stringify(process.argv.slice(1)));
  } catch (e) {
    jlog("error=" + (e && e.message ? e.message : String(e)));
  }
})();

'@

$main = $main.Replace($marker, ($block + $marker))
[System.IO.File]::WriteAllText($mainPath, $main, [System.Text.UTF8Encoding]::new($false))

& node $asarBin pack $stage $asar
if ($LASTEXITCODE -ne 0) { throw "asar pack failed" }

$defaultsObj = [ordered]@{
  oss       = $oss
  userData  = (Join-Path $root ".userdata-oss")
  workspace = (Join-Path $root "OllamaCode.code-workspace")
  workRoots = @("E:\Work", "D:\Work", (Join-Path $env:USERPROFILE "Projects"), $env:USERPROFILE)
}
[System.IO.File]::WriteAllText(
  (Join-Path $electronDir "ollamacode-defaults.json"),
  ($defaultsObj | ConvertTo-Json -Compress),
  [System.Text.UTF8Encoding]::new($false)
)

Set-Content -Path (Join-Path $electronDir "ollamacode-shim.ok") -Value "v4 $(Get-Date -Format o)" -Encoding ASCII
Write-Host "Electron jump-list shim V4 installed (default_app.asar)"
Write-Host "  $asar"
