# Legacy: Extension Development Host inside Microsoft VS Code (shows [EDH] in title).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$ext = Join-Path $root "extensions\ollama-agent"
$data = Join-Path $root ".userdata"
$code = Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\Code.exe"
if (-not (Test-Path $code)) { throw "Нужен Microsoft VS Code: $code" }
New-Item -ItemType Directory -Force -Path (Join-Path $data "User") | Out-Null
Copy-Item (Join-Path $root "config\userdata-settings.json") (Join-Path $data "User\settings.json") -Force
if (Test-Path (Join-Path $root "config\userdata-argv.json")) {
  Copy-Item (Join-Path $root "config\userdata-argv.json") (Join-Path $data "argv.json") -Force
}
Set-Location $ext
if (-not (Test-Path "node_modules")) { npm install --registry https://registry.npmjs.org/ --no-audit --no-fund }
npm run compile
$workspace = Join-Path $root "OllamaCode.code-workspace"
$kill = @("GitHub.copilot","GitHub.copilot-chat","GitHub.copilot-nightly","github.vscode-pull-request-github")
$launchArgs = [System.Collections.Generic.List[string]]::new()
$launchArgs.Add("--user-data-dir=$data")
$launchArgs.Add("--extensions-dir=$data\extensions")
$launchArgs.Add("--disable-extensions")
foreach ($id in $kill) { $launchArgs.Add("--disable-extension=$id") }
$launchArgs.Add("--extensionDevelopmentPath=$ext")
$launchArgs.Add("--disable-telemetry")
$launchArgs.Add("--new-window")
$launchArgs.Add($workspace)
Write-Host "OllamaCode EDH (legacy) — лучше используй scripts\launch.ps1"
Start-Process -FilePath $code -ArgumentList $launchArgs.ToArray()
