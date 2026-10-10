# Build multi-size .ico from the canonical brand PNG (ide/icons/ollamacode.png).
# Re-bakes from official Ollama llama (app.ico) + brackets unless SKIP_BRAND_BAKE=1.
# Then stamps Electron EXE + win32 resources when OllamaCode is not running.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Add-Type -AssemblyName System.Drawing

$icoOut = Join-Path $root "ide\ollamacode.ico"
$icoApp = Join-Path $root "ide\ollamacode-app.ico"
# Stable path — timestamped desk icons broke the desktop .lnk after rebuilds
$icoLink = Join-Path $root "ide\ollamacode-desk.ico"
$mediaIco = Join-Path $root "extensions\ollama-agent\media\icon.ico"
$mediaPng = Join-Path $root "extensions\ollama-agent\media\icon.png"
$rootPng = Join-Path $root "ollamacode-icon.png"
$masterPng = Join-Path $root "ide\brand\code-icon-1024.png"
$canonicalPng = Join-Path $root "ide\icons\ollamacode.png"
$officialIco = "$env:LOCALAPPDATA\Programs\Ollama\app.ico"
$officialPng = Join-Path $root "ide\brand\ollama-official.png"
New-Item -ItemType Directory -Force -Path (Join-Path $root "ide\brand") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $root "ide\icons") | Out-Null

# Clean legacy timestamped desk icons (shortcut used to point at these)
Get-ChildItem (Join-Path $root "ide") -Filter "ollamacode-desk-*.ico" -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue

# Refresh official llama source from installed Ollama, then bake brand PNG
if ($env:SKIP_BRAND_BAKE -ne "1") {
  if (Test-Path $officialIco) {
    try {
      python -c @"
from PIL import Image
im = Image.open(r'$officialIco')
best = None
for i in range(getattr(im, 'n_frames', 1)):
    im.seek(i)
    frame = im.copy().convert('RGBA')
    if best is None or frame.size[0] > best.size[0]:
        best = frame
best.save(r'$officialPng')
print('official llama', best.size)
"@
    } catch {
      Write-Host "warn: could not extract Ollama app.ico: $_"
    }
  }
  $bake = Join-Path $PSScriptRoot "bake-brand-icon.py"
  if ((Test-Path $bake) -and (Test-Path $officialPng)) {
    python $bake
  }
}

function Scale-IconPng([string]$srcPath, [int]$size) {
  $src = [System.Drawing.Image]::FromFile($srcPath)
  try {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($src, 0, 0, $size, $size)
    $g.Dispose()
    # Seal near-opaque dark plate to exact #0b1220 (no alpha holes in Windows shell)
    for ($y = 0; $y -lt $size; $y++) {
      for ($x = 0; $x -lt $size; $x++) {
        $c = $bmp.GetPixel($x, $y)
        if ($c.A -ge 220 -and $c.R -lt 45 -and $c.G -lt 45 -and $c.B -lt 55) {
          $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, 0x0b, 0x12, 0x20))
        }
      }
    }
    return $bmp
  } finally {
    $src.Dispose()
  }
}

if (-not (Test-Path $canonicalPng)) {
  throw "Missing canonical brand PNG: $canonicalPng"
}

Write-Host "baking icons from canonical PNG: $canonicalPng"

# Refresh masters
Copy-Item $canonicalPng $masterPng -Force
Copy-Item $canonicalPng $rootPng -Force
Copy-Item $canonicalPng $mediaPng -Force

$sizes = @(16, 32, 48, 64, 128, 256)
$parts = New-Object System.Collections.Generic.List[byte[]]
foreach ($s in $sizes) {
  $bmp = Scale-IconPng $canonicalPng ([int]$s)
  $mid = $bmp.GetPixel([int]($s / 2), [int]($s / 2))
  if ($mid.A -lt 200) { throw "size $s center too transparent A=$($mid.A)" }
  $pngMs = New-Object System.IO.MemoryStream
  $bmp.Save($pngMs, [System.Drawing.Imaging.ImageFormat]::Png)
  $parts.Add($pngMs.ToArray())
  $pngMs.Dispose()
  $bmp.Dispose()
  Write-Host ("  {0}x{0} ok" -f $s)
}

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$parts.Count)
$offset = 6 + 16 * $parts.Count
for ($i = 0; $i -lt $parts.Count; $i++) {
  $dim = $sizes[$i]
  $bw.Write([byte]($(if ($dim -ge 256) { 0 } else { $dim })))
  $bw.Write([byte]($(if ($dim -ge 256) { 0 } else { $dim })))
  $bw.Write([byte]0)
  $bw.Write([byte]0)
  $bw.Write([uint16]1)
  $bw.Write([uint16]32)
  $bw.Write([uint32]$parts[$i].Length)
  $bw.Write([uint32]$offset)
  $offset += $parts[$i].Length
}
foreach ($png in $parts) { $bw.Write($png) }
$bw.Flush()
$all = $ms.ToArray()
$bw.Dispose()
$ms.Dispose()

[IO.File]::WriteAllBytes($icoOut, $all)
[IO.File]::WriteAllBytes($mediaIco, $all)
[IO.File]::WriteAllBytes($icoApp, $all)
[IO.File]::WriteAllBytes($icoLink, $all)

foreach ($win32 in @(
  (Join-Path $root ".cache\vscode\resources\win32"),
  (Join-Path $root ".cache\vscode-140\resources\win32")
)) {
  if (Test-Path $win32) {
    Copy-Item $icoOut (Join-Path $win32 "code.ico") -Force
    Copy-Item $rootPng (Join-Path $win32 "code_150x150.png") -Force
    Copy-Item $rootPng (Join-Path $win32 "code_70x70.png") -Force
  }
}

# Workbench titlebar / watermark brand
foreach ($dir in @("out", "src")) {
  $media = Join-Path $root ".cache\vscode-140\$dir\vs\workbench\browser\media"
  if (Test-Path $media) {
    Copy-Item $rootPng (Join-Path $media "code-icon.png") -Force
  }
}

$running = [bool](Get-Process -Name "OllamaCode" -EA SilentlyContinue)
foreach ($exe in @(
  (Join-Path $root ".cache\vscode\.build\electron\OllamaCode.exe"),
  (Join-Path $root ".cache\vscode-140\.build\electron\OllamaCode.exe")
)) {
  if (-not (Test-Path $exe)) { continue }
  if ($running) {
    Write-Host "rcedit skipped (OllamaCode running): $exe"
    continue
  }
  $rceditBin = @(
    (Join-Path $root ".cache\vscode-140\node_modules\rcedit\bin\rcedit.exe"),
    (Join-Path $root ".cache\vscode\node_modules\rcedit\bin\rcedit.exe"),
    (Join-Path $root ".cache\vscode-140\node_modules\@electron\rcedit\bin\rcedit.exe")
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $rceditBin) { Write-Host "rcedit.exe not found - skip $exe"; continue }
  try {
    & $rceditBin $exe --set-icon $icoOut
    if ($LASTEXITCODE -eq 0) { Write-Host "icon stamped: $exe" }
    else { Write-Host "rcedit exit $($LASTEXITCODE): $exe" }
  } catch {
    Write-Host "rcedit skipped: $_"
  }
}

Set-Content -Path (Join-Path $root "ide\desk-icon.path") -Value $icoLink -Encoding ASCII
Write-Host ("Icon ready: " + $icoOut + " size=" + (Get-Item $icoOut).Length)
Write-Host ("Desk icon:  " + $icoLink)
