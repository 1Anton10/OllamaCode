$ErrorActionPreference = "Stop"
$bt = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools"
$vsDev = Join-Path $bt "Common7\Tools\VsDevCmd.bat"
if (-not (Test-Path $vsDev)) { throw "VsDevCmd.bat not found: $vsDev" }

$oss = "E:\Work\OllamaCode\.cache\vscode"
$env:vs2022_install = $bt

# Import VS env into this PowerShell session
cmd /c "`"$vsDev`" -arch=amd64 -host_arch=amd64 && set" | ForEach-Object {
  if ($_ -match '^(.*?)=(.*)$') {
    [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2])
  }
}

Write-Host "LIB=$env:LIB"
Set-Location $oss
npm install --foreground-scripts
Write-Host "npm install exit: $LASTEXITCODE"
