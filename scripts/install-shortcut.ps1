# Desktop + Start Menu shortcut for OllamaCode (silent, no EDH, no terminal).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
& "$PSScriptRoot\make-icon.ps1"

$vbs = Join-Path $root "OllamaCode.vbs"
$ico = Join-Path $root "ide\ollamacode.ico"
$pathFile = Join-Path $root "ide\desk-icon.path"
$icoLink = Join-Path $root "ide\ollamacode-desk.ico"
if (-not (Test-Path $icoLink) -and (Test-Path $pathFile)) {
  $fromPath = (Get-Content $pathFile -Raw).Trim()
  if ($fromPath -and (Test-Path $fromPath)) { $icoLink = $fromPath }
}
if (-not (Test-Path $icoLink)) {
  $icoLink = Join-Path $root "ide\ollamacode-app.ico"
  if ((Test-Path $ico) -and -not (Test-Path $icoLink)) { Copy-Item $ico $icoLink -Force }
}
if (-not (Test-Path $icoLink) -and (Test-Path $ico)) { $icoLink = $ico }
$desktop = [Environment]::GetFolderPath("Desktop")
$lnkPath = Join-Path $desktop "OllamaCode.lnk"

# Keep a cmd launcher for debugging (shows console)
$cmdPath = Join-Path $root "OllamaCode.cmd"
@(
  "@echo off",
  "title OllamaCode",
  "powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\launch.ps1`" %*"
) | Set-Content -Path $cmdPath -Encoding ASCII

if (-not (Test-Path $vbs)) {
  throw "Missing $vbs"
}

$w = New-Object -ComObject WScript.Shell
$sc = $w.CreateShortcut($lnkPath)
$sc.TargetPath = $vbs
$sc.WorkingDirectory = $root
$sc.WindowStyle = 1
$sc.Description = "OllamaCode - local Ollama IDE (Code-OSS fork)"
if (Test-Path $icoLink) { $sc.IconLocation = "$icoLink,0" }
elseif (Test-Path $ico) { $sc.IconLocation = "$ico,0" }
$sc.Save()

$start = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
New-Item -ItemType Directory -Force -Path $start | Out-Null
Copy-Item $lnkPath (Join-Path $start "OllamaCode.lnk") -Force

# Prefer pinning the real exe (Windows DestList / recent folders). Shim V3 rewrites argv.
. (Join-Path $PSScriptRoot "_oss-path.ps1")
$ossPinRoot = Get-OllamaCodeOssRoot $root
$exePin = Join-Path $ossPinRoot ".build\electron\OllamaCode.exe"
$taskbar = Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"
if ((Test-Path $taskbar) -and (Test-Path $exePin)) {
  Get-ChildItem $taskbar -Filter "*.lnk" -EA SilentlyContinue | ForEach-Object {
    try {
      $pin = $w.CreateShortcut($_.FullName)
      $tgt = [string]$pin.TargetPath
      if ($tgt -match 'OllamaCode\.(exe|vbs|cmd)$' -or $_.BaseName -match 'OllamaCode') {
        $pin.TargetPath = $exePin
        $pin.WorkingDirectory = (Split-Path $exePin)
        $pin.Arguments = ""
        if (Test-Path $icoLink) { $pin.IconLocation = "$icoLink,0" }
        elseif (Test-Path $ico) { $pin.IconLocation = "$ico,0" }
        $pin.Description = "OllamaCode"
        $pin.Save()
        Write-Host "Taskbar pin → exe (shim V3): $($_.Name)"
      }
    } catch {
      Write-Host "WARN: taskbar pin $($_.Name): $_"
    }
  }
}

& "$PSScriptRoot\install-electron-shim.ps1"
& "$PSScriptRoot\install-context-menu.ps1"

Write-Host "Desktop:   $lnkPath"
Write-Host "StartMenu: $(Join-Path $start 'OllamaCode.lnk')"
Write-Host "Target:    $vbs (silent → launch.ps1)"
Write-Host "Taskbar:   OllamaCode.exe + jump-list shim V3 (recent folders)"
Write-Host "Debug:     $cmdPath (with console)"
Write-Host "Icon:      $icoLink"
Write-Host "If icon looks cached: right-click desktop > Refresh, or log off once."
Write-Host "If folder from taskbar opens blank: run scripts\install-electron-shim.ps1 once."
