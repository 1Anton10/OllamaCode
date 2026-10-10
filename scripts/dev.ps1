$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$ext = Join-Path $root "extensions\ollama-agent"
Set-Location $ext
if (-not (Test-Path "node_modules")) { npm install }
npm run compile
$code = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
if (-not (Test-Path $code)) { $code = "code" }
Write-Host "Launch Extension Development Host..."
& $code --extensionDevelopmentPath="$ext" "$root"
