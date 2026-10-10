# Put OllamaCode into hot-reload / debug mode from terminal.
# - Compiles + watches extension TS
# - Watches Code-OSS workbench (npm run watch)
# - Soft-reloads the running window (no full Electron restart)
param(
  [switch]$WatchOnly,
  [switch]$Reload,
  [switch]$Launch
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "_oss-path.ps1")
$oss = Get-OllamaCodeOssRoot $root
$ext = Join-Path $root "extensions\ollama-agent"
$data = Join-Path $root ".userdata-oss"
$pidFile = Join-Path $root ".cache\ollamacode-dev.pids.json"

function Save-Pids($obj) {
  New-Item -ItemType Directory -Force -Path (Split-Path $pidFile) | Out-Null
  $obj | ConvertTo-Json | Set-Content $pidFile -Encoding utf8
}

function Soft-Reload {
  # Builtin extension is loaded from OSS extensions/ — sync compiled workspace copy first
  Write-Host "Syncing ollama-agent + workbench out/ before soft reload..."
  node (Join-Path $PSScriptRoot "sync-ollama-agent.mjs")
  if ($LASTEXITCODE -ne 0) { throw "sync-ollama-agent failed" }
  node (Join-Path $PSScriptRoot "sync-workbench-out.mjs")
  if ($LASTEXITCODE -ne 0) { throw "sync-workbench-out failed" }
  $trigger = Join-Path $env:USERPROFILE ".ollamacode\reload.trigger"
  New-Item -ItemType Directory -Force -Path (Split-Path $trigger) | Out-Null
  Set-Content -Path $trigger -Value ((Get-Date).Ticks.ToString()) -Encoding utf8
  Write-Host "Reload trigger → $trigger"
  Write-Host "Окно OllamaCode само сделает Reload Window (без рестарта Electron)."
}

  if ($Reload) {
  Soft-Reload
  return
}

# Hot-reload watcher only when this script runs with -Launch / watch
$env:OLLAMACODE_HOT = "1"

# Ensure patches + first compile
if (-not $WatchOnly) {
  if (Test-Path (Join-Path $PSScriptRoot "apply-oss-patches.mjs")) {
    node (Join-Path $PSScriptRoot "apply-oss-patches.mjs")
  }
}

Set-Location $ext
if (-not (Test-Path "node_modules")) {
  npm install --registry https://registry.npmjs.org/ --no-audit --no-fund
}
npm run compile

Write-Host "========================================"
Write-Host " OllamaCode DEV HOT"
Write-Host " Extension watch + OSS watch"
Write-Host " РџСЂР°РІРєРё в†’ Р°РІС‚РѕРєРѕРјРїРёР»СЏС†РёСЏ в†’ Reload Window"
Write-Host " Soft reload:  .\scripts\dev-hot.ps1 -Reload"
Write-Host "========================================"

$extWatch = Start-Process -FilePath "npm" -ArgumentList @("run", "watch") -WorkingDirectory $ext -PassThru -WindowStyle Minimized
$ossWatch = $null
if (Test-Path (Join-Path $oss "package.json")) {
  $ossWatch = Start-Process -FilePath "npm" -ArgumentList @("run", "watch") -WorkingDirectory $oss -PassThru -WindowStyle Minimized
}

Save-Pids @{
  extensionWatch = $extWatch.Id
  ossWatch = if ($ossWatch) { $ossWatch.Id } else { $null }
  started = (Get-Date).ToString("o")
}

Write-Host "Extension watch PID: $($extWatch.Id)"
if ($ossWatch) { Write-Host "OSS watch PID: $($ossWatch.Id)" }

if ($Launch -or -not $WatchOnly) {
  & "$PSScriptRoot\launch.ps1" -Dev -NoWatch
}

if ($WatchOnly) {
  Write-Host "Watchers running. РћСЃС‚Р°РІСЊ СЌС‚Рѕ РѕРєРЅРѕ / РїСЂРѕС†РµСЃСЃС‹. Soft-reload:"
  Write-Host "  powershell -File $PSScriptRoot\dev-hot.ps1 -Reload"
  # Keep script alive so user sees status; watchers are separate processes.
  try {
    while ($true) {
      Start-Sleep -Seconds 30
      if ($extWatch.HasExited) { Write-Host "extension watch exited"; break }
    }
  } finally {
    Write-Host "dev-hot ending (watchers may still run in background)"
  }
}

