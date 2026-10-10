# DEPRECATED path: EDH inside Microsoft VS Code.
# По умолчанию теперь запускаем настоящий standalone OllamaCode (Code-OSS).
# Для старого EDH: $env:OLLAMACODE_EDH=1
$ErrorActionPreference = "Stop"
if ($env:OLLAMACODE_EDH -eq "1") {
  & "$PSScriptRoot\_open-edh.ps1"
  return
}
& "$PSScriptRoot\launch.ps1"
