# OllamaCode OSS developer mode:
# - npm install (once)
# - npm run watch (hot reload of workbench — no full reinstall on each edit)
# - scripts/code.bat Electron window with ollama-agent built-in
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "_oss-path.ps1")
$oss = Get-OllamaCodeOssRoot $root

if (-not (Test-Path $oss)) {
  & "$PSScriptRoot\bootstrap-oss.ps1"
}

node "$PSScriptRoot\apply-oss-patches.mjs"

# compile extension TS (linked into OSS)
Set-Location (Join-Path $root "extensions\ollama-agent")
if (-not (Test-Path "node_modules")) {
  npm install --registry https://registry.npmjs.org/ --no-audit --no-fund
}
npm run compile

Set-Location $oss

# Build Tools path hint for node-gyp
$bt = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools"
if (Test-Path $bt) { $env:vs2022_install = $bt }

if (-not (Test-Path (Join-Path $oss "node_modules"))) {
  Write-Host "npm install in Code-OSS (first time = long)…"
  cmd /c "$PSScriptRoot\oss-npm-install.cmd"
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
}

# Ensure electron downloaded
if (-not (Test-Path (Join-Path $oss ".build\electron"))) {
  Write-Host "Downloading Electron runtime…"
  npm run electron
}

$data = Join-Path $root ".userdata-oss"
New-Item -ItemType Directory -Force -Path $data | Out-Null
$userDir = Join-Path $data "User"
New-Item -ItemType Directory -Force -Path $userDir | Out-Null
Copy-Item (Join-Path $root "config\userdata-settings.json") (Join-Path $userDir "settings.json") -Force

Write-Host @"

========================================
 OllamaCode OSS DEV
 Hot-reload: keep 'npm run watch' running
 Electron: scripts\code.bat (separate terminal)
 Profile: $data
========================================

Starting watch (client + extensions)…
In another terminal after compile finishes:

  cd $oss
  .\scripts\code.bat --user-data-dir=$data --disable-telemetry

Or this script will try to launch after ~90s once out/ exists.

"@

# Start watch in background
$watch = Start-Process -FilePath "npm" -ArgumentList @("run","watch") -WorkingDirectory $oss -PassThru -WindowStyle Normal

# Wait for first compile artifacts
$deadline = (Get-Date).AddMinutes(15)
$ready = $false
while ((Get-Date) -lt $deadline) {
  if ((Test-Path (Join-Path $oss "out\main.js")) -and (Test-Path (Join-Path $oss "out\vs\workbench\workbench.desktop.main.js"))) {
    $ready = $true
    break
  }
  Start-Sleep -Seconds 5
  Write-Host "waiting for compile…"
}

if ($ready) {
  Write-Host "Launching OllamaCode Electron…"
  $codeBat = Join-Path $oss "scripts\code.bat"
  Start-Process -FilePath $codeBat -ArgumentList @(
    "--user-data-dir=$data",
    "--disable-telemetry",
    "--disable-extension=GitHub.copilot",
    "--disable-extension=GitHub.copilot-chat",
    (Join-Path $root "OllamaCode.code-workspace")
  ) -WorkingDirectory $oss
} else {
  Write-Host "Compile still running. When watch is green, run:"
  Write-Host "  cd $oss"
  Write-Host "  .\scripts\code.bat --user-data-dir=$data"
}

Write-Host "Watch PID: $($watch.Id) — leave that window open while developing."
