# Launch standalone OllamaCode (Code-OSS Electron).
# Default = FAST: fat esbuild bundle in out-fast, no VSCODE_DEV (no 9k ESM graph).
# -DevModules = old slow path (transpile out/ + VSCODE_DEV) for hot-patching workbench.
param(
  [switch]$Dev,
  [switch]$DevModules,
  [switch]$NoWatch,
  [switch]$Silent,
  [switch]$ForceBundle,
  [switch]$NoKill,
  [string]$Workspace = ""
)
# Explorer "Open with…" passes an explicit folder/file — do not kill a live IDE.
$explicitWorkspace = -not [string]::IsNullOrWhiteSpace($Workspace)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "_oss-path.ps1")
$oss = Get-OllamaCodeOssRoot $root
$data = Join-Path $root ".userdata-oss"
$exe = Join-Path $oss ".build\electron\OllamaCode.exe"
$sqliteNode = Join-Path $oss "node_modules\@vscode\sqlite3\build\Release\vscode-sqlite3.node"
$ext = Join-Path $root "extensions\ollama-agent"
$outDir = Join-Path $oss "out"
$outDev = Join-Path $oss "out-dev"
$outFast = Join-Path $oss "out-fast"
$useFast = -not $DevModules

function Write-Info([string]$msg) {
  if (-not $Silent) { Write-Host $msg }
}

function Test-IsJunction([string]$path) {
  if (-not (Test-Path $path)) { return $false }
  $item = Get-Item $path -Force
  return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function Set-OutJunction([string]$target) {
  if (-not (Test-Path $target)) { throw "Missing bundle/transpile dir: $target" }
  # Preserve real transpile tree once
  if ((Test-Path $outDir) -and -not (Test-IsJunction $outDir) -and -not (Test-Path $outDev)) {
    Write-Info "Preserving transpile tree as out-devвЂ¦"
    Rename-Item $outDir "out-dev"
  }
  if (Test-Path $outDir) {
    if (Test-IsJunction $outDir) {
      cmd /c "rmdir `"$outDir`"" | Out-Null
    } else {
      # Unexpected real folder вЂ” move aside
      $bak = "$outDir.bak-$(Get-Date -Format yyyyMMddHHmmss)"
      Rename-Item $outDir $bak
      Write-Info "Moved unexpected out/ в†’ $bak"
    }
  }
  cmd /c "mklink /J `"$outDir`" `"$target`"" | Out-Null
  if (-not (Test-IsJunction $outDir)) { throw "Failed to junction out в†’ $target" }
  Write-Info "out в†’ $target"
}

if (-not (Test-Path $oss)) {
  throw "Run bootstrap first: scripts\bootstrap-oss.ps1"
}
if (-not (Test-Path $exe)) {
  Write-Info "Downloading Electron..."
  Push-Location $oss
  npm run electron
  Pop-Location
}

# Taskbar jump-list opens OllamaCode.exe <folder> → blank "Electron" without shim.
$shimDefaults = Join-Path (Split-Path $exe) "ollamacode-defaults.json"
$shimStamp = Join-Path (Split-Path $exe) "ollamacode-shim.ok"
$needShim = -not ((Test-Path $shimStamp) -and (Test-Path $shimDefaults))
if (-not $needShim) {
  try {
    $stampTxt = Get-Content $shimStamp -Raw -EA SilentlyContinue
    if ($stampTxt -notmatch 'v4') { $needShim = $true }
  } catch { $needShim = $true }
}
function Write-ShimDefaults {
  $defaultsObj = [ordered]@{
    oss       = $oss
    userData  = $data
    workspace = (Join-Path $root "OllamaCode.code-workspace")
    workRoots = @("E:\Work", "D:\Work", (Join-Path $env:USERPROFILE "Projects"), $env:USERPROFILE)
  }
  [System.IO.File]::WriteAllText(
    $shimDefaults,
    ($defaultsObj | ConvertTo-Json -Compress),
    [System.Text.UTF8Encoding]::new($false)
  )
}
if ($needShim) {
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "install-electron-shim.ps1") | Out-Null
  } catch {
    Write-Info "WARN: electron shim: $_"
  }
} else {
  try { Write-ShimDefaults } catch {}
}

# Native sqlite is required
if (-not (Test-Path $sqliteNode)) {
  Write-Info "Missing vscode-sqlite3.node - rebuilding..."
  $rc = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", (Join-Path $PSScriptRoot "rebuild-sqlite.cmd")) -Wait -PassThru -NoNewWindow
  if ($rc.ExitCode -ne 0 -or -not (Test-Path $sqliteNode)) {
    throw "Failed to build @vscode/sqlite3. Run: scripts\rebuild-sqlite.cmd"
  }
}

# node-pty conpty + iselevated
$conptyDll = Join-Path $oss "node_modules\node-pty\build\Release\conpty\conpty.dll"
$iselevated = Join-Path $oss "node_modules\native-is-elevated\build\Release\iselevated.node"
if (-not (Test-Path $conptyDll) -or -not (Test-Path $iselevated)) {
  Write-Info "Restoring native modules (conpty / iselevated)..."
  if (-not (Test-Path $iselevated)) {
    $rc = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", (Join-Path $PSScriptRoot "rebuild-natives.cmd")) -Wait -PassThru -NoNewWindow
    if ($rc.ExitCode -ne 0) { Write-Info "WARN: rebuild-natives.cmd failed (exit $($rc.ExitCode))" }
  } else {
    node (Join-Path $PSScriptRoot "ensure-node-pty-conpty.mjs") | Out-Null
  }
}

$legacyExe = Join-Path $root ".cache\vscode\.build\electron\OllamaCode.exe"
if ((Test-Path $legacyExe) -and ($oss -like "*vscode-140*")) {
  Write-Info "Note: legacy .cache\vscode also has OllamaCode.exe - launch always uses: $oss"
}

function Stop-OllamaCodeZombies {
  $procs = @(Get-Process -Name "OllamaCode" -ErrorAction SilentlyContinue)
  if (-not $procs.Count) { return }
  Write-Info ("Stopping {0} leftover OllamaCode process(es)..." -f $procs.Count)
  foreach ($p in $procs) {
    try { taskkill /F /T /PID $p.Id 2>$null | Out-Null } catch {
      try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
  Start-Sleep -Milliseconds 600
  $left = @(Get-Process -Name "OllamaCode" -ErrorAction SilentlyContinue)
  if ($left.Count) {
    $left | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 400
  }
}
# Do not kill a healthy running IDE — that makes every "open" feel like a cold first boot.
# "Responding" alone is not enough: hung Electron often stays Responding=True with no window.
function Get-HealthyOllamaCode {
  @(Get-Process -Name "OllamaCode" -ErrorAction SilentlyContinue | Where-Object {
    $_.Responding -and $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle)
  })
}
function Focus-OllamaCodeWindow {
  param([System.Diagnostics.Process]$Proc)
  if (-not $Proc -or $Proc.MainWindowHandle -eq 0) { return $false }
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class OcFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@ -ErrorAction SilentlyContinue
  try {
    if ([OcFocus]::IsIconic($Proc.MainWindowHandle)) { [void][OcFocus]::ShowWindow($Proc.MainWindowHandle, 9) }
    else { [void][OcFocus]::ShowWindow($Proc.MainWindowHandle, 5) }
    return [OcFocus]::SetForegroundWindow($Proc.MainWindowHandle)
  } catch { return $false }
}
if (-not $NoKill -and -not $explicitWorkspace) {
  $alive = @(Get-HealthyOllamaCode)
  if (-not $alive.Count) {
    Stop-OllamaCodeZombies
  }
}

$bootTimer = [Diagnostics.Stopwatch]::StartNew()
$extJs = Join-Path $ext "out\extension.js"
$wbMain = Join-Path $outFast "vs\workbench\workbench.desktop.main.js"
$bundleStamp = Join-Path $outFast ".ollamacode-bundle-stamp"
$timingLog = Join-Path $root ".cache\launch-timing.log"

function Test-FastBootReady {
  if ($ForceBundle -or $Dev -or $DevModules) { return $false }
  if (-not (Test-Path $exe)) { return $false }
  if (-not (Test-Path $sqliteNode)) { return $false }
  if (-not (Test-Path $extJs)) { return $false }
  if (-not (Test-Path $wbMain)) { return $false }
  if ((Get-Item $wbMain).Length -lt 5MB) { return $false }
  if (-not (Test-Path $bundleStamp)) { return $false }
  # Extension sources newer than build → must compile before launch
  $jsTime = (Get-Item $extJs).LastWriteTimeUtc
  $marker = Join-Path $ext "src"
  if (Test-Path $marker) {
    $newest = Get-ChildItem $marker -Recurse -File -EA SilentlyContinue |
      Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($newest -and $newest.LastWriteTimeUtc -gt $jsTime) { return $false }
  }
  return $true
}

function Ensure-OutPointsTo([string]$target) {
  if ((Test-Path $outDir) -and (Test-IsJunction $outDir)) {
    try {
      $cur = (Get-Item $outDir -Force).Target
      if ($cur -is [array]) { $cur = $cur[0] }
      if ($cur -and ([string]$cur).TrimEnd('\') -ieq $target.TrimEnd('\')) { return }
    } catch {}
  }
  Set-OutJunction $target
}

function Ensure-UserDataSeed {
  New-Item -ItemType Directory -Force -Path (Join-Path $data "User") | Out-Null
  $settingsSrc = Join-Path $root "config\userdata-settings.json"
  $settingsPath = Join-Path $data "User\settings.json"
  if (-not (Test-Path $settingsPath)) {
    Copy-Item $settingsSrc $settingsPath -Force
  } else {
    # Force privacy defaults even if user already has settings.json
    try {
      $src = Get-Content $settingsSrc -Raw -Encoding UTF8 | ConvertFrom-Json
      $dst = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $privacyKeys = @(
        "telemetry.telemetryLevel",
        "telemetry.enableCrashReporter",
        "telemetry.feedback.enabled",
        "update.mode",
        "workbench.enableExperiments"
      )
      $changed = $false
      foreach ($k in $privacyKeys) {
        if ($null -ne $src.$k -and [string]$dst.$k -ne [string]$src.$k) {
          $dst | Add-Member -NotePropertyName $k -NotePropertyValue $src.$k -Force
          $changed = $true
        }
      }
      if ($changed) {
        $json = $dst | ConvertTo-Json -Depth 20
        [System.IO.File]::WriteAllText($settingsPath, $json, [System.Text.UTF8Encoding]::new($false))
      }
    } catch {
      Write-Info "WARN: privacy settings merge: $_"
    }
  }
  if (Test-Path $settingsPath) {
    $bytes = [System.IO.File]::ReadAllBytes($settingsPath)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
      [System.IO.File]::WriteAllBytes($settingsPath, $bytes[3..($bytes.Length - 1)])
    }
  }
  $argvSrc = Join-Path $root "config\userdata-argv.json"
  $argvDst = Join-Path $data "argv.json"
  if ((Test-Path $argvSrc) -and -not (Test-Path $argvDst)) {
    Copy-Item $argvSrc $argvDst -Force
  } elseif ((Test-Path $argvSrc) -and (Test-Path $argvDst)) {
    try {
      $dstArgv = Get-Content $argvDst -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($dstArgv.'enable-crash-reporter' -ne $false) {
        $dstArgv | Add-Member -NotePropertyName "enable-crash-reporter" -NotePropertyValue $false -Force
        $json = $dstArgv | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($argvDst, $json, [System.Text.UTF8Encoding]::new($false))
      }
    } catch {}
  }
}

$fastBoot = Test-FastBootReady
if ($fastBoot) {
  Write-Info "Fast boot (skip patches/bundle/compile)"
  Ensure-OutPointsTo $outFast
  Ensure-UserDataSeed
  # Housekeeping at most once per 10 minutes — must not delay the window
  $syncStamp = Join-Path $root ".cache\last-fast-maint.stamp"
  $needMaint = $true
  if (Test-Path $syncStamp) {
    try {
      $age = (Get-Date).ToUniversalTime() - (Get-Item $syncStamp).LastWriteTimeUtc
      if ($age.TotalMinutes -lt 10) { $needMaint = $false }
    } catch {}
  }
  if ($needMaint) {
    $maint = @(
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command",
      @"
`$ErrorActionPreference='SilentlyContinue'
Set-Location '$root'
node 'scripts\purge-ollama-agent-user.mjs' | Out-Null
node 'scripts\migrate-chat-model-storage.mjs' | Out-Null
node 'scripts\sync-ollama-agent.mjs' | Out-Null
New-Item -ItemType Directory -Force -Path '.cache' | Out-Null
Set-Content -Path '.cache\last-fast-maint.stamp' -Value (Get-Date -Format o) -Encoding ASCII
"@
    )
    Start-Process -FilePath "powershell.exe" -ArgumentList $maint -WindowStyle Hidden | Out-Null
  }
} else {
  # Full prep path (first build / after source changes)
  Push-Location $ext
  try {
    if (-not (Test-Path "node_modules")) {
      npm install --registry https://registry.npmjs.org/ --no-audit --no-fund
    }
    $needCompile = $true
    if (Test-Path $extJs) {
      $jsTime = (Get-Item $extJs).LastWriteTimeUtc
      $newestSrc = Get-ChildItem (Join-Path $ext "src") -Recurse -File -EA SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
      if ($newestSrc -and $newestSrc.LastWriteTimeUtc -le $jsTime) { $needCompile = $false }
    }
    if ($needCompile) {
      Write-Info "Compiling ollama-agent..."
      npm run compile
      if ($LASTEXITCODE -ne 0) { throw "ollama-agent compile failed" }
    } else {
      Write-Info "ollama-agent already compiled"
      node (Join-Path $root "scripts\sync-ollama-agent.mjs") | Out-Null
    }
  } finally {
    Pop-Location
  }

  $patchLog = Join-Path $root ".cache\last-apply-patches.log"
  New-Item -ItemType Directory -Force -Path (Split-Path $patchLog) | Out-Null
  $patchOut = & node (Join-Path $PSScriptRoot "apply-oss-patches.mjs") 2>&1
  $patchCode = $LASTEXITCODE
  $patchOut | Set-Content -Path $patchLog -Encoding utf8
  if (-not $Silent) { $patchOut | ForEach-Object { Write-Host $_ } }
  if ($patchCode -ne 0) {
    throw "apply-oss-patches.mjs failed (exit $patchCode). See $patchLog"
  }

  try { node (Join-Path $PSScriptRoot "purge-ollama-agent-user.mjs") | Out-Null } catch {
    Write-Info "WARN: purge user extension: $_"
  }
  try { node (Join-Path $PSScriptRoot "migrate-chat-model-storage.mjs") | Out-Null } catch {
    Write-Info "migrate warn: $_"
  }

  if ($useFast) {
    $bundleArgs = @()
    if ($ForceBundle) { $bundleArgs += "-Force" }
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "bundle-desktop.ps1") @bundleArgs
    if ($LASTEXITCODE -ne 0) { throw "bundle-desktop.ps1 failed" }
    Ensure-OutPointsTo $outFast
  } else {
    if ((Test-Path $outDev) -and (-not (Test-Path $outDir) -or (Test-IsJunction $outDir))) {
      if (Test-IsJunction $outDir) { cmd /c "rmdir `"$outDir`"" | Out-Null }
      Ensure-OutPointsTo $outDev
    } elseif (-not (Test-Path $outDir)) {
      throw "Missing out/ transpile tree. Run OSS compile/watch once, or omit -DevModules to use out-fast."
    }
    $wbOut = & node (Join-Path $PSScriptRoot "sync-workbench-out.mjs") 2>&1
    if (-not $Silent) { $wbOut | ForEach-Object { Write-Host $_ } }
    if ($LASTEXITCODE -ne 0) { throw "sync-workbench-out.mjs failed" }
  }

  Ensure-UserDataSeed
}

# Desktop shortcut: no -Workspace → restore last session (one window).
# Explorer / jump-list: pass -Workspace <folder> explicitly.
function Resolve-OpenTarget([string]$raw) {
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  $raw = $raw.Trim().Trim('"')
  $candidates = New-Object System.Collections.Generic.List[string]
  $candidates.Add($raw) | Out-Null
  try { $candidates.Add([IO.Path]::GetFullPath($raw)) | Out-Null } catch {}
  $leaf = [IO.Path]::GetFileName($raw.TrimEnd('\', '/'))
  foreach ($base in @("E:\Work", $root, (Join-Path $env:USERPROFILE "Projects"), $env:USERPROFILE, "D:\Work")) {
    if (-not $base) { continue }
    $candidates.Add((Join-Path $base $leaf)) | Out-Null
    $candidates.Add((Join-Path $base $raw)) | Out-Null
  }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) {
      return (Get-Item -LiteralPath $c).FullName
    }
  }
  return $null
}

$openPath = $null
$openKind = $null # folder | file | workspace
if ($explicitWorkspace) {
  $resolved = Resolve-OpenTarget $Workspace
  if ($resolved) {
    $openPath = $resolved
    if ($resolved -match '\.code-workspace$') { $openKind = "workspace" }
    elseif (Test-Path -LiteralPath $resolved -PathType Container) { $openKind = "folder" }
    else { $openKind = "file" }
  } else {
    Write-Info "WARN: path not found: $Workspace"
  }
}

$argsList = [System.Collections.Generic.List[string]]::new()
$argsList.Add(".")
$argsList.Add("--user-data-dir=$data")
$argsList.Add("--builtin-extensions-dir=$(Join-Path $oss 'extensions')")
$argsList.Add("--extensions-dir=$(Join-Path $data 'extensions')")
$argsList.Add("--disable-telemetry")
$argsList.Add("--disable-updates")
$argsList.Add("--disable-extension=GitHub.copilot")
$argsList.Add("--disable-extension=GitHub.copilot-chat")
$argsList.Add("--disable-extension=GitHub.copilot-nightly")
$argsList.Add("--disable-extension=vscode.vscode-api-tests")
# Skip heavy built-ins that fight local Ollama boot
foreach ($id in @(
  "github.vscode-pull-request-github",
  "ms-vscode.js-debug-companion",
  "ms-vscode.vscode-js-profile-table"
)) {
  $argsList.Add("--disable-extension=$id")
}
if ($Dev) {
  $argsList.Add("--extensionDevelopmentPath=$ext")
}
if ($openPath) {
  $argsList.Add("--reuse-window")
  if ($openKind -eq "folder") {
    # Force folder open (jump-list short names otherwise become empty text files)
    $folderUri = "file:///" + ($openPath -replace "\\", "/")
    $argsList.Add("--folder-uri=$folderUri")
  } elseif ($openKind -eq "workspace" -or $openKind -eq "file") {
    $argsList.Add($openPath)
  }
} else {
  # Desktop shortcut: restore last session only (window.restoreWindows=one)
  $argsList.Add("--reuse-window")
}

$env:VSCODE_SKIP_PRELAUNCH = "1"
$env:VSCODE_CLI = "1"
Remove-Item Env:VSCODE_DEV -ErrorAction SilentlyContinue
Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
if ($useFast) {
  # Built mode: workbench.html + single 40MB bundle (fast)
  $env:NODE_ENV = "production"
} else {
  $env:NODE_ENV = "development"
  $env:VSCODE_DEV = "1"
}

if (-not $Silent) {
  Write-Host "========================================"
  Write-Host " OllamaCode 1.140"
  Write-Host " Exe: $exe"
  Write-Host " Profile: $data"
  if ($fastBoot) { Write-Host " Boot: FAST-PATH (ready artifacts)" }
  elseif ($useFast) { Write-Host " Boot: FAST (out-fast bundle, no VSCODE_DEV)" }
  else { Write-Host " Boot: DEV modules (VSCODE_DEV, slow)" }
  if ($Dev) { Write-Host " Mode: EDH" }
  Write-Host (" Prep: {0} ms" -f $bootTimer.ElapsedMilliseconds)
  Write-Host "========================================"
}

try {
  New-Item -ItemType Directory -Force -Path (Split-Path $timingLog) | Out-Null
  Add-Content -Path $timingLog -Encoding utf8 -Value (
    "{0:o} prep_ms={1} fastBoot={2} workspace={3}" -f (Get-Date).ToUniversalTime(), $bootTimer.ElapsedMilliseconds, $fastBoot, $Workspace
  )
} catch {}

$healthy = @(Get-HealthyOllamaCode)

# Already running + user picked a folder (Explorer / jump-list via VBS) → delegate to exe shim → IPC
if ($healthy.Count -and $openPath) {
  Write-Info "Open in running OllamaCode via IPC: $openPath"
  Start-Process -FilePath $exe -ArgumentList @($openPath) | Out-Null
  exit 0
}

# Already running + no new folder → just focus (avoids cold second Electron = "slow open")
if ($healthy.Count -and -not $openPath) {
  $focused = Focus-OllamaCodeWindow -Proc $healthy[0]
  Write-Info ("Focused existing OllamaCode (pid={0}, ok={1})" -f $healthy[0].Id, $focused)
  exit 0
}

Start-Process -FilePath $exe -ArgumentList $argsList.ToArray() -WorkingDirectory $oss | Out-Null

if ($Dev -and -not $NoWatch) {
  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoExit", "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $PSScriptRoot "dev-hot.ps1"),
    "-WatchOnly"
  ) | Out-Null
}

if (-not $Silent) {
  Write-Host "Launched. Shortcut: scripts\install-shortcut.ps1"
}

