@echo off
REM Rebuild @vscode/sqlite3 (+ helpers) against Electron for OllamaCode 1.140
setlocal
set OSS=E:\Work\OllamaCode\.cache\vscode-140
set MSVCLIB=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.51.36231\lib\x64
set PATH=C:\nvm4w\nodejs;%PATH%
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set LINK=/LIBPATH:"%MSVCLIB%"
set LIB=%MSVCLIB%;%LIB%

cd /d "%OSS%"
call npm run electron

cd /d "%OSS%\node_modules\@vscode\sqlite3"
if exist build rmdir /s /q build 2>nul
mkdir build
copy /Y "%MSVCLIB%\delayimp.lib" build\delayimp.lib >nul
call npx node-gyp rebuild --release --target=43.7.3 --dist-url=https://electronjs.org/headers --runtime=electron
if not exist build\Release\vscode-sqlite3.node exit /b 1
echo OK: vscode-sqlite3.node
