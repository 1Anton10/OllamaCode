# Build a fat desktop bundle into .cache/vscode-140/out-fast (~20s).
# Launch uses this by default (no VSCODE_DEV / no 9k ESM graph).
param(
  [switch]$Force
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "_oss-path.ps1")
$oss = Get-OllamaCodeOssRoot $root
$outFast = Join-Path $oss "out-fast"
$stamp = Join-Path $outFast ".ollamacode-bundle-stamp"
$wbMain = Join-Path $outFast "vs\workbench\workbench.desktop.main.js"

function Get-PatchFingerprint {
  $files = @(
    (Join-Path $root "scripts\sync-workbench-out.mjs"),
    (Join-Path $oss "src\vs\workbench\services\extensions\electron-browser\localProcessExtensionHost.ts"),
    (Join-Path $oss "src\vs\workbench\contrib\chat\browser\widget\input\modelPicker\media\modelPicker.css"),
    (Join-Path $oss "src\vs\workbench\contrib\chat\browser\widget\media\chat.css"),
    (Join-Path $oss "src\vs\workbench\browser\parts\titlebar\media\titlebarpart.css"),
    (Join-Path $oss "src\vs\workbench\browser\media\code-icon.png"),
    (Join-Path $oss "src\vs\platform\cssDev\node\cssDevService.ts")
  )
  $h = [System.Security.Cryptography.SHA256]::Create()
  $ms = New-Object System.IO.MemoryStream
  foreach ($f in $files) {
    if (-not (Test-Path $f)) { continue }
    $bytes = [IO.File]::ReadAllBytes($f)
    $ms.Write($bytes, 0, $bytes.Length)
  }
  $hash = ($h.ComputeHash($ms.ToArray()) | ForEach-Object { $_.ToString("x2") }) -join ""
  $ms.Dispose(); $h.Dispose()
  return $hash
}

$fp = Get-PatchFingerprint
if (-not $Force -and (Test-Path $wbMain) -and ((Get-Item $wbMain).Length -gt 5MB) -and (Test-Path $stamp)) {
  $prev = (Get-Content $stamp -Raw).Trim()
  if ($prev -eq $fp) {
    Write-Host "out-fast bundle up to date"
    exit 0
  }
}

Write-Host "Syncing patched workbench modules into out/ (for source of truth)..."
node (Join-Path $PSScriptRoot "sync-workbench-out.mjs") | Out-Host

Write-Host "Bundling desktop -> out-fast (esbuild, ~20-40s)..."
$env:NODE_OPTIONS = "--max-old-space-size=8192"
Push-Location $oss
try {
  node --experimental-strip-types build/next/index.ts bundle --out out-fast --target desktop
  if ($LASTEXITCODE -ne 0) { throw "bundle failed exit $LASTEXITCODE" }
} finally {
  Pop-Location
}

if (-not (Test-Path $wbMain) -or ((Get-Item $wbMain).Length -lt 5MB)) {
  throw "Bundle missing or too small: $wbMain"
}

# Ensure brand PNG survives resource copy
$brand = Join-Path $root "ide\icons\ollamacode.png"
$destPng = Join-Path $outFast "vs\workbench\browser\media\code-icon.png"
if ((Test-Path $brand) -and (Test-Path (Split-Path $destPng))) {
  Copy-Item $brand $destPng -Force
}

Set-Content -Path $stamp -Value $fp -Encoding ASCII
$mb = [math]::Round((Get-Item $wbMain).Length / 1MB, 1)
Write-Host "Bundle ready: $mb MB"
