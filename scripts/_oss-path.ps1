# Shared OSS path: prefer 1.140 tree; fall back to legacy .cache\vscode
function Get-OllamaCodeOssRoot {
  param([string]$Root)
  $v140 = Join-Path $Root ".cache\vscode-140"
  $legacy = Join-Path $Root ".cache\vscode"
  if (Test-Path (Join-Path $v140 "package.json")) {
    try {
      $ver = (Get-Content (Join-Path $v140 "package.json") -Raw | ConvertFrom-Json).version
      if ($ver -like "1.140*") { return $v140 }
    } catch { }
    return $v140
  }
  return $legacy
}
