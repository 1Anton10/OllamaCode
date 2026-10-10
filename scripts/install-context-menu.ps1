# Register Explorer "Open with OllamaCode" (HKCU, no admin).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$openCmd = Join-Path $root "open-folder.cmd"
$ico = Join-Path $root "ide\ollamacode-desk.ico"
if (-not (Test-Path -LiteralPath $ico)) {
  $ico = Join-Path $root "ide\ollamacode.ico"
}
if (-not (Test-Path -LiteralPath $openCmd)) { throw "Missing $openCmd" }

$label = (-join [char[]]@(
  0x041E,0x0442,0x043A,0x0440,0x044B,0x0442,0x044C,0x0020,
  0x0441,0x0020,0x043F,0x043E,0x043C,0x043E,0x0449,0x044C,0x044E,0x0020
)) + "OllamaCode"

function Escape-Reg([string]$s) {
  return ($s -replace '\\', '\\' -replace '"', '\"')
}

# Same shape as Cursor: "app" "%V"
$cmdDir = Escape-Reg ("`"$openCmd`" `"%V`"")
$cmdFile = Escape-Reg ("`"$openCmd`" `"%1`"")
$icoEsc = Escape-Reg $ico
$labelEsc = Escape-Reg $label

$regBody = @"
Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\Software\Classes\Directory\shell\OllamaCode]
@="$labelEsc"
"Icon"="$icoEsc"

[HKEY_CURRENT_USER\Software\Classes\Directory\shell\OllamaCode\command]
@="$cmdDir"

[HKEY_CURRENT_USER\Software\Classes\Directory\Background\shell\OllamaCode]
@="$labelEsc"
"Icon"="$icoEsc"

[HKEY_CURRENT_USER\Software\Classes\Directory\Background\shell\OllamaCode\command]
@="$cmdDir"

[HKEY_CURRENT_USER\Software\Classes\Drive\shell\OllamaCode]
@="$labelEsc"
"Icon"="$icoEsc"

[HKEY_CURRENT_USER\Software\Classes\Drive\shell\OllamaCode\command]
@="$cmdDir"

[HKEY_CURRENT_USER\Software\Classes\*\shell\OllamaCode]
@="$labelEsc"
"Icon"="$icoEsc"

[HKEY_CURRENT_USER\Software\Classes\*\shell\OllamaCode\command]
@="$cmdFile"
"@

$regPath = Join-Path $env:TEMP "ollamacode-shell.reg"
[System.IO.File]::WriteAllText($regPath, $regBody, [System.Text.UnicodeEncoding]::new($false, $true))
& reg.exe import $regPath
if ($LASTEXITCODE -ne 0) { throw "reg import failed: $regPath" }

Write-Host "Explorer context menu installed:"
Write-Host "  $label"
Write-Host "  $cmdDir"
