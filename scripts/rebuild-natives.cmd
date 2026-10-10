@echo off
REM Rebuild native modules that Electron needs at runtime (OllamaCode 1.140 / Electron 43.7.3)
setlocal
set OSS=E:\Work\OllamaCode\.cache\vscode-140
set MSVCLIB=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.51.36231\lib\x64
set PATH=C:\nvm4w\nodejs;%PATH%
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set LINK=/LIBPATH:"%MSVCLIB%"
set LIB=%MSVCLIB%;%LIB%
set ELECTRON_TARGET=43.7.3

cd /d "%OSS%"

echo === native-is-elevated ===
cd /d "%OSS%\node_modules\native-is-elevated"
if exist build rmdir /s /q build 2>nul
REM Spectre libs often missing on BuildTools — disable
powershell -NoProfile -Command "(Get-Content binding.gyp -Raw) -replace '\"SpectreMitigation\": \"Spectre\"','\"SpectreMitigation\": \"false\"' | Set-Content binding.gyp -NoNewline"
call npx --yes node-gyp rebuild --release --target=%ELECTRON_TARGET% --dist-url=https://electronjs.org/headers --runtime=electron
if not exist build\Release\iselevated.node (
  echo FAIL: iselevated.node
  exit /b 1
)
echo OK: iselevated.node

echo === node-pty conpty assets ===
cd /d "%OSS%"
call node "E:\Work\OllamaCode\scripts\ensure-node-pty-conpty.mjs"
if not exist "%OSS%\node_modules\node-pty\build\Release\conpty\conpty.dll" (
  echo FAIL: conpty.dll
  exit /b 1
)
echo OK: conpty.dll

echo === done ===
exit /b 0
