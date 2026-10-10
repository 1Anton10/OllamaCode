# Full Windows package build (slow). Prefer oss-dev.ps1 for daily work.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$oss = Join-Path $root ".cache\vscode"
& "$PSScriptRoot\bootstrap-oss.ps1"
Set-Location $oss
if (-not (Test-Path "node_modules")) { npm install }
npm run gulp -- vscode-win32-x64
Write-Host "Output under $oss\.build\win32-x64"
Write-Host "Copy to C:\Program Files\OllamaCode or run installer if produced."
