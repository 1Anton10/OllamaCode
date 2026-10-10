# Bootstrap Code-OSS + apply OllamaCode patches
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "_oss-path.ps1")
$tag = if ($env:VSCODE_TAG) { $env:VSCODE_TAG } else { "1.140.0" }
$oss = if ($env:OLLAMACODE_OSS) { $env:OLLAMACODE_OSS } else { Join-Path $root ".cache\vscode-140" }

Write-Host "OllamaCode bootstrap Code-OSS @$tag → $oss"
New-Item -ItemType Directory -Force -Path (Join-Path $root ".cache") | Out-Null

if (-not (Test-Path (Join-Path $oss ".git"))) {
  Write-Host "Cloning microsoft/vscode (shallow)..."
  git clone --depth 1 --branch $tag https://github.com/microsoft/vscode.git $oss
} else {
  Write-Host "vscode cache exists: $oss"
  Push-Location $oss
  try {
    $cur = (Get-Content "package.json" -Raw | ConvertFrom-Json).version
    Write-Host "current version: $cur"
  } finally { Pop-Location }
}

node (Join-Path $root "scripts\apply-oss-patches.mjs")

Write-Host @"

Next:
  $($root)\scripts\oss-dev.ps1

"@
