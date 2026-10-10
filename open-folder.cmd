@echo off
REM Open a folder/file in OllamaCode (Explorer "Open with" + debugging).
set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%ROOT%scripts\launch.ps1" -Silent -Workspace "%~1"
