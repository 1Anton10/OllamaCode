# OllamaCode Windows desktop UI helper (UI Automation + user32).
# Generic for ANY app. Input: JSON on stdin → JSON on stdout.
param()
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WinUiNative {
  public const uint INPUT_MOUSE = 0;
  public const uint INPUT_KEYBOARD = 1;
  public const uint MOUSEEVENTF_MOVE = 0x0001;
  public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;
  public const int SW_RESTORE = 9;
  public const int SW_SHOW = 5;
  public const int SW_MINIMIZE = 6;
  public const int SW_MAXIMIZE = 3;
  public const uint WM_CLOSE = 0x0010;

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public InputUnion U;
  }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int dwProcessId);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

function Out-Json($obj) {
  ($obj | ConvertTo-Json -Depth 10 -Compress)
}

# UI Automation BoundingRectangle often returns Infinity - never cast raw to [int]
function Safe-Int($v, [int]$fallback = 0) {
  try {
    if ($null -eq $v) { return $fallback }
    if ($v -is [double] -or $v -is [float] -or $v -is [decimal]) {
      $d = [double]$v
      if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return $fallback }
      if ($d -gt [int]::MaxValue -or $d -lt [int]::MinValue) { return $fallback }
      return [int][Math]::Round($d)
    }
    $s = [string]$v
    if ([string]::IsNullOrWhiteSpace($s)) { return $fallback }
    if ($s -match 'Infinity|NaN|\u221E') { return $fallback }
    return [int][Math]::Round([double]$s)
  } catch {
    return $fallback
  }
}

function Get-ScreenSize {
  return @{
    width = [WinUiNative]::GetSystemMetrics(0)
    height = [WinUiNative]::GetSystemMetrics(1)
  }
}

function Get-WindowsList {
  param([switch]$IncludeHidden)
  $list = New-Object System.Collections.Generic.List[object]
  $cb = [WinUiNative+EnumWindowsProc]{
    param($h,$lp)
    $visible = [WinUiNative]::IsWindowVisible($h)
    if (-not $IncludeHidden -and -not $visible) { return $true }
    $sb = New-Object System.Text.StringBuilder 512
    [void][WinUiNative]::GetWindowText($h, $sb, $sb.Capacity)
    $title = $sb.ToString()
    if ([string]::IsNullOrWhiteSpace($title) -and -not $IncludeHidden) { return $true }
    $winPid = [uint32]0
    [void][WinUiNative]::GetWindowThreadProcessId($h, [ref]$winPid)
    $proc = ""
    try { $proc = (Get-Process -Id $winPid -ErrorAction SilentlyContinue).ProcessName } catch {}
    $rect = New-Object WinUiNative+RECT
    [void][WinUiNative]::GetWindowRect($h, [ref]$rect)
    $w = [Math]::Max(0, $rect.Right - $rect.Left)
    $hh = [Math]::Max(0, $rect.Bottom - $rect.Top)
    $list.Add([pscustomobject]@{
      hwnd = [int64]$h
      title = $title
      pid = $winPid
      process = $proc
      left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom
      width = $w; height = $hh
      visible = [bool]$visible
      on_screen = ($visible -and $w -gt 40 -and $hh -gt 40 -and $rect.Left -gt -10000)
    }) | Out-Null
    return $true
  }
  [void][WinUiNative]::EnumWindows($cb, [IntPtr]::Zero)
  return $list
}

function Find-ProcessWindows([string]$processName) {
  # Find ANY hwnd owned by process (visible or tray/hidden) - Telegram often trays with MainWindowHandle=0
  $p = [string]$processName
  if (-not $p) { return @() }
  $pids = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -like "*$p*"
  } | ForEach-Object { $_.Id })
  if (-not $pids.Count) { return @() }
  $pidSet = @{}
  foreach ($id in $pids) { $pidSet[[int]$id] = $true }
  $all = @(Get-WindowsList -IncludeHidden)
  return @($all | Where-Object { $pidSet.ContainsKey([int]$_.pid) } | Sort-Object {
    - $(if ($_.on_screen) { 1000000 } else { 0 }) - $_.width * $_.height
  })
}

function Find-Hwnd($hwnd, $title, $process) {
  if ($null -ne $hwnd -and "$hwnd" -ne "" -and [int64]$hwnd -ne 0) {
    return [IntPtr]([int64]$hwnd)
  }
  $wins = @(Get-WindowsList)
  $t = if ($title) { [string]$title } else { "" }
  $p = if ($process) { [string]$process } else { "" }

  function Score-Win($w) {
    $s = 0
    if ($w.on_screen) { $s += 1000 }
    $s += [Math]::Min(500, [int](($w.width * $w.height) / 10000))
    if ($p -and ($w.process -like "*$p*")) { $s += 500 }
    if ($t -and ($w.title -like "*$t*")) { $s += 400 }
    if ($p -and ($w.title -like "*$p*")) { $s += 200 }
    return $s
  }

  $matched = @($wins)
  if ($t -or $p) {
    $matched = @($wins | Where-Object {
      (($t -and ($_.title -like "*$t*")) -or ($p -and ($_.process -like "*$p*" -or $_.title -like "*$p*")))
    })
  }
  if (-not $matched.Count -and $p) {
    $matched = @(Find-ProcessWindows $p)
  }
  if (-not $matched.Count -and $p) {
    $gp = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.ProcessName -like "*$p*" -and $_.MainWindowHandle -ne 0
    })
    if ($gp.Count) { return [IntPtr]$gp[0].MainWindowHandle }
    return [IntPtr]::Zero
  }
  $best = @($matched | Sort-Object { - (Score-Win $_) })
  if ($best.Count) { return [IntPtr]$best[0].hwnd }
  return [IntPtr]::Zero
}

function Filter-WindowsList($wins, $req) {
  $out = @($wins)
  if ($req.process) {
    $p = [string]$req.process
    $out = @($out | Where-Object { $_.process -like "*$p*" -or $_.title -like "*$p*" })
    if (-not $out.Count) {
      # tray / hidden Telegram etc.
      $out = @(Find-ProcessWindows $p)
    }
  }
  if ($req.title) {
    $t = [string]$req.title
    $out = @($out | Where-Object { $_.title -like "*$t*" })
  }
  if ($req.on_screen_only -ne $false) {
    if ($null -eq $req.on_screen_only -or $req.on_screen_only -eq $true) {
      $on = @($out | Where-Object { $_.on_screen })
      if ($on.Count) { $out = $on }
      # keep tray matches if nothing on screen (so model sees process is alive)
    }
  }
  return @($out)
}

function Focus-Window([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { throw "window not found" }
  # NEVER synthesize Alt (keybd_event 0x12) - stuck Alt + F4 kills apps.
  # Always Restore first: Telegram in tray is often not IsIconic but still invisible.
  [void][WinUiNative]::ShowWindow($h, [WinUiNative]::SW_RESTORE)
  [void][WinUiNative]::ShowWindow($h, [WinUiNative]::SW_SHOW)
  try { [void][WinUiNative]::AllowSetForegroundWindow(-1) } catch {}
  [void][WinUiNative]::BringWindowToTop($h)

  $fg = [WinUiNative]::GetForegroundWindow()
  $dummy = [uint32]0
  $fgTid = [WinUiNative]::GetWindowThreadProcessId($fg, [ref]$dummy)
  $targetPid = [uint32]0
  $targetTid = [WinUiNative]::GetWindowThreadProcessId($h, [ref]$targetPid)
  $curTid = [WinUiNative]::GetCurrentThreadId()
  $attachedFg = $false
  $attachedTarget = $false
  if ($fgTid -ne 0 -and $fgTid -ne $curTid) {
    $attachedFg = [WinUiNative]::AttachThreadInput($curTid, $fgTid, $true)
  }
  if ($targetTid -ne 0 -and $targetTid -ne $curTid -and $targetTid -ne $fgTid) {
    $attachedTarget = [WinUiNative]::AttachThreadInput($curTid, $targetTid, $true)
  }
  [void][WinUiNative]::SetForegroundWindow($h)
  if ($attachedFg) { [void][WinUiNative]::AttachThreadInput($curTid, $fgTid, $false) }
  if ($attachedTarget) { [void][WinUiNative]::AttachThreadInput($curTid, $targetTid, $false) }
  Start-Sleep -Milliseconds 180
  if ([WinUiNative]::GetForegroundWindow() -ne $h) {
    [void][WinUiNative]::ShowWindow($h, [WinUiNative]::SW_RESTORE)
    [void][WinUiNative]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 100
  }
}

function Click-At([int]$x, [int]$y, [string]$button = "left", [int]$clicks = 1) {
  $screen = Get-ScreenSize
  $vx = [int](65535 * $x / [Math]::Max(1, $screen.width))
  $vy = [int](65535 * $y / [Math]::Max(1, $screen.height))
  [void][WinUiNative]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 40
  $down = [WinUiNative]::MOUSEEVENTF_LEFTDOWN
  $up = [WinUiNative]::MOUSEEVENTF_LEFTUP
  if ($button -eq "right") { $down = [WinUiNative]::MOUSEEVENTF_RIGHTDOWN; $up = [WinUiNative]::MOUSEEVENTF_RIGHTUP }
  elseif ($button -eq "middle") { $down = [WinUiNative]::MOUSEEVENTF_MIDDLEDOWN; $up = [WinUiNative]::MOUSEEVENTF_MIDDLEUP }
  $sz = [System.Runtime.InteropServices.Marshal]::SizeOf([type][WinUiNative+INPUT])
  for ($i = 0; $i -lt [Math]::Max(1, $clicks); $i++) {
    $inputs = @( (New-Object WinUiNative+INPUT), (New-Object WinUiNative+INPUT) )
    $inputs[0].type = [WinUiNative]::INPUT_MOUSE
    $inputs[0].U.mi.dx = $vx; $inputs[0].U.mi.dy = $vy
    $inputs[0].U.mi.dwFlags = [WinUiNative]::MOUSEEVENTF_ABSOLUTE -bor [WinUiNative]::MOUSEEVENTF_MOVE -bor $down
    $inputs[1].type = [WinUiNative]::INPUT_MOUSE
    $inputs[1].U.mi.dx = $vx; $inputs[1].U.mi.dy = $vy
    $inputs[1].U.mi.dwFlags = [WinUiNative]::MOUSEEVENTF_ABSOLUTE -bor [WinUiNative]::MOUSEEVENTF_MOVE -bor $up
    [void][WinUiNative]::SendInput(2, $inputs, $sz)
    Start-Sleep -Milliseconds 60
  }
}

function Move-Mouse([int]$x, [int]$y) {
  [void][WinUiNative]::SetCursorPos($x, $y)
}

function Scroll-At([int]$x, [int]$y, [int]$delta) {
  Move-Mouse $x $y
  Start-Sleep -Milliseconds 30
  $screen = Get-ScreenSize
  $vx = [int](65535 * $x / [Math]::Max(1, $screen.width))
  $vy = [int](65535 * $y / [Math]::Max(1, $screen.height))
  $inp = New-Object WinUiNative+INPUT
  $inp.type = [WinUiNative]::INPUT_MOUSE
  $inp.U.mi.dx = $vx; $inp.U.mi.dy = $vy
  $inp.U.mi.mouseData = [uint32]([int16]$delta)
  $inp.U.mi.dwFlags = [WinUiNative]::MOUSEEVENTF_ABSOLUTE -bor [WinUiNative]::MOUSEEVENTF_MOVE -bor [WinUiNative]::MOUSEEVENTF_WHEEL
  $sz = [System.Runtime.InteropServices.Marshal]::SizeOf([type][WinUiNative+INPUT])
  [void][WinUiNative]::SendInput(1, @($inp), $sz)
}

function Type-Text([string]$text) {
  foreach ($ch in $text.ToCharArray()) {
    $down = New-Object WinUiNative+INPUT
    $up = New-Object WinUiNative+INPUT
    $down.type = [WinUiNative]::INPUT_KEYBOARD
    $down.U.ki.wScan = [uint16][int][char]$ch
    $down.U.ki.dwFlags = [WinUiNative]::KEYEVENTF_UNICODE
    $up.type = [WinUiNative]::INPUT_KEYBOARD
    $up.U.ki.wScan = [uint16][int][char]$ch
    $up.U.ki.dwFlags = [WinUiNative]::KEYEVENTF_UNICODE -bor [WinUiNative]::KEYEVENTF_KEYUP
    $sz = [System.Runtime.InteropServices.Marshal]::SizeOf([type][WinUiNative+INPUT])
    [void][WinUiNative]::SendInput(2, @($down,$up), $sz)
  }
}

function Send-KeysSafe([string]$keys) {
  [System.Windows.Forms.SendKeys]::SendWait($keys)
}

$script:ProtectedProcesses = @(
  'telegram','telegramdesktop','discord','slack','whatsapp','signal','element','skype','teams','ms-teams','zoom',
  'chrome','msedge','firefox','opera','brave','vivaldi',
  'ollamacode','code','electron','cursor',
  'explorer','dwm','csrss','winlogon','taskmgr','systemsettings','searchhost','shellexperiencehost',
  'startmenuexperiencehost','applicationframehost'
)

function Test-IsQuitKeys([string]$keys) {
  if ([string]::IsNullOrWhiteSpace($keys)) { return $false }
  if ($keys -match '%\{?\s*F4\s*\}?' -or $keys -match '!\{?\s*F4\s*\}?') { return $true }
  return $false
}

function Get-WindowProcessName([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { return "" }
  $winPid = [uint32]0
  [void][WinUiNative]::GetWindowThreadProcessId($h, [ref]$winPid)
  try {
    $n = (Get-Process -Id $winPid -ErrorAction SilentlyContinue).ProcessName
    if ($n) { return [string]$n }
  } catch {}
  return ""
}

function Test-IsProtectedProcess([string]$proc, [string]$title = "") {
  $p = ([string]$proc).Trim().ToLowerInvariant().Replace('.exe','')
  foreach ($x in $script:ProtectedProcesses) {
    if ($p -and ($p -eq $x -or $p.Contains($x) -or $x.Contains($p))) { return $true }
  }
  if ($title -match '(?i)\b(telegram|discord|slack|whatsapp|signal|microsoft teams|ollamacode)\b') { return $true }
  return $false
}

$script:IdeProcesses = @('ollamacode','cursor','code')

function Test-IsIdeProcess([string]$proc) {
  $p = ([string]$proc).Trim().ToLowerInvariant().Replace('.exe','')
  foreach ($x in $script:IdeProcesses) {
    if ($p -and ($p -eq $x -or $p.Contains($x))) { return $true }
  }
  return $false
}

function Assert-NotIdeTarget([IntPtr]$h, [string]$why = "action") {
  $proc = Get-WindowProcessName $h
  if (Test-IsIdeProcess $proc) {
    throw "REFUSED: $why on IDE process=$proc - windows_desktop must not click/type/focus-drive OllamaCode/Cursor (that closed the editor before)"
  }
}

function Assert-SafeDestructive([IntPtr]$h, [string]$titleHint, [string]$processHint, [string]$keys = "") {
  $proc = $processHint
  $title = $titleHint
  if ($h -ne [IntPtr]::Zero) {
    $live = Get-WindowProcessName $h
    if ($live) { $proc = $live }
    $sb = New-Object System.Text.StringBuilder 512
    [void][WinUiNative]::GetWindowText($h, $sb, $sb.Capacity)
    if ($sb.Length -gt 0) { $title = $sb.ToString() }
  }
  if (Test-IsProtectedProcess $proc $title) {
    $short = if ($title.Length -gt 60) { $title.Substring(0, 60) } else { $title }
    throw "REFUSED: protected app process=$proc title=$short - never close/Alt+F4 messengers/browsers/IDE"
  }
  if (Test-IsQuitKeys $keys) {
    throw "REFUSED: Alt+F4/quit keys blocked"
  }
}

function Get-UiTree([IntPtr]$h, [int]$maxDepth = 4, [int]$maxNodes = 150) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  if (-not $root) { return @() }
  $nodes = New-Object System.Collections.Generic.List[object]
  function Walk($el, $depth) {
    if ($nodes.Count -ge $maxNodes -or $depth -gt $maxDepth) { return }
    try {
      $name = $el.Current.Name
      $ctype = $el.Current.ControlType.ProgrammaticName
      $aid = $el.Current.AutomationId
      $rect = $el.Current.BoundingRectangle
      $enabled = $el.Current.IsEnabled
      $x = Safe-Int $rect.X
      $y = Safe-Int $rect.Y
      $w = Safe-Int $rect.Width
      $hh = Safe-Int $rect.Height
      if (-not [string]::IsNullOrWhiteSpace($name) -or -not [string]::IsNullOrWhiteSpace($aid) -or $ctype -match "Button|Edit|Menu|List|Tree|Tab|Hyperlink|CheckBox|ComboBox|RadioButton|Document|Text|Pane|Window") {
        $nodes.Add([pscustomobject]@{
          name = $name
          automation_id = $aid
          type = $ctype
          enabled = $enabled
          x = $x; y = $y
          w = $w; h = $hh
          cx = $x + [int]($w / 2)
          cy = $y + [int]($hh / 2)
          depth = $depth
        }) | Out-Null
      }
      $children = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($c in $children) { Walk $c ($depth + 1) }
    } catch {}
  }
  Walk $root 0
  return $nodes
}

function Find-UiElement([IntPtr]$h, [string]$name, [string]$automationId, [string]$controlType) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  if (-not $root) { return $null }
  $conds = New-Object System.Collections.Generic.List[System.Windows.Automation.Condition]
  if ($name) {
    $conds.Add((New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty, $name))) | Out-Null
  }
  if ($automationId) {
    $conds.Add((New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $automationId))) | Out-Null
  }
  if ($controlType) {
    $ct = $null
    switch -Regex ($controlType) {
      'button' { $ct = [System.Windows.Automation.ControlType]::Button }
      'edit|text' { $ct = [System.Windows.Automation.ControlType]::Edit }
      'menu' { $ct = [System.Windows.Automation.ControlType]::MenuItem }
      'list' { $ct = [System.Windows.Automation.ControlType]::ListItem }
      'tab' { $ct = [System.Windows.Automation.ControlType]::TabItem }
      'check' { $ct = [System.Windows.Automation.ControlType]::CheckBox }
      'combo' { $ct = [System.Windows.Automation.ControlType]::ComboBox }
      'hyper|link' { $ct = [System.Windows.Automation.ControlType]::Hyperlink }
      default { }
    }
    if ($ct) {
      $conds.Add((New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ct))) | Out-Null
    }
  }
  if ($conds.Count -eq 0) { return $null }
  $cond = if ($conds.Count -eq 1) { $conds[0] } else {
    New-Object System.Windows.Automation.AndCondition($conds.ToArray())
  }
  $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if ($el) { return $el }
  # fallback: substring name match via tree walk
  if ($name) {
    $needle = $name.ToLowerInvariant()
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $stack = New-Object System.Collections.Generic.Stack[object]
    $stack.Push($root)
    $n = 0
    while ($stack.Count -gt 0 -and $n -lt 400) {
      $n++
      $cur = $stack.Pop()
      try {
        $nm = [string]$cur.Current.Name
        if ($nm -and $nm.ToLowerInvariant().Contains($needle)) { return $cur }
        $child = $walker.GetFirstChild($cur)
        while ($child) {
          $stack.Push($child)
          $child = $walker.GetNextSibling($child)
        }
      } catch {}
    }
  }
  return $null
}

function Element-Info($el) {
  if (-not $el) { return $null }
  $rect = $el.Current.BoundingRectangle
  $x = Safe-Int $rect.X
  $y = Safe-Int $rect.Y
  $w = Safe-Int $rect.Width
  $hh = Safe-Int $rect.Height
  return [pscustomobject]@{
    name = $el.Current.Name
    automation_id = $el.Current.AutomationId
    type = $el.Current.ControlType.ProgrammaticName
    enabled = $el.Current.IsEnabled
    x = $x; y = $y
    w = $w; h = $hh
    cx = $x + [int]($w / 2)
    cy = $y + [int]($hh / 2)
  }
}

function Invoke-UiElement($el) {
  try {
    $inv = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    if ($inv) { $inv.Invoke(); return "invoke" }
  } catch {}
  try {
    $sel = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    if ($sel) { $sel.Select(); return "select" }
  } catch {}
  try {
    $tog = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    if ($tog) { $tog.Toggle(); return "toggle" }
  } catch {}
  $rect = $el.Current.BoundingRectangle
  $cx = [int]($rect.X + $rect.Width / 2)
  $cy = [int]($rect.Y + $rect.Height / 2)
  Click-At $cx $cy "left" 1
  return "click"
}

function Capture-Shot([string]$path, [IntPtr]$h) {
  $dir = Split-Path -Parent $path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  if ($h -ne [IntPtr]::Zero) {
    $r = New-Object WinUiNative+RECT
    [void][WinUiNative]::GetWindowRect($h, [ref]$r)
    $w = [Math]::Max(1, $r.Right - $r.Left)
    $hh = [Math]::Max(1, $r.Bottom - $r.Top)
    $bmp = New-Object System.Drawing.Bitmap $w, $hh
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w,$hh)))
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  } else {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  }
  return $path
}

function Resolve-Coords($req, [IntPtr]$h) {
  $x = [int]$req.x; $y = [int]$req.y
  if ($req.relative -eq $true -and $h -ne [IntPtr]::Zero) {
    $r = New-Object WinUiNative+RECT
    [void][WinUiNative]::GetWindowRect($h, [ref]$r)
    $x = $r.Left + $x; $y = $r.Top + $y
  }
  return @{ x = $x; y = $y }
}

$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) { Out-Json @{ ok = $false; error = "empty stdin" }; exit 1 }
$req = $raw | ConvertFrom-Json
$action = [string]$req.action

try {
  switch ($action) {
    "list_windows" {
      $wins = Filter-WindowsList (Get-WindowsList) $req
      Out-Json @{
        ok = $true
        screen = (Get-ScreenSize)
        count = @($wins).Count
        windows = @($wins | Select-Object -First 80)
        filter = @{ title = [string]$req.title; process = [string]$req.process }
      }
    }
    "foreground" {
      $h = [WinUiNative]::GetForegroundWindow()
      $sb = New-Object System.Text.StringBuilder 512
      [void][WinUiNative]::GetWindowText($h, $sb, $sb.Capacity)
      $winPid = [uint32]0
      [void][WinUiNative]::GetWindowThreadProcessId($h, [ref]$winPid)
      $proc = ""
      try { $proc = (Get-Process -Id $winPid -EA SilentlyContinue).ProcessName } catch {}
      Out-Json @{ ok = $true; hwnd = [int64]$h; title = $sb.ToString(); pid = $winPid; process = $proc; screen = (Get-ScreenSize) }
    }
    "focus" {
      $h = Find-Hwnd $req.hwnd $req.title $req.process
      if ($h -eq [IntPtr]::Zero) { throw "window not found" }
      Assert-NotIdeTarget $h "focus"
      Focus-Window $h
      $fg = [WinUiNative]::GetForegroundWindow()
      $sb = New-Object System.Text.StringBuilder 512
      [void][WinUiNative]::GetWindowText($fg, $sb, $sb.Capacity)
      $visible = [WinUiNative]::IsWindowVisible($h)
      $r = New-Object WinUiNative+RECT
      [void][WinUiNative]::GetWindowRect($h, [ref]$r)
      $w = [Math]::Max(0, $r.Right - $r.Left)
      $hh = [Math]::Max(0, $r.Bottom - $r.Top)
      Out-Json @{
        ok = $true
        hwnd = [int64]$h
        foreground = [int64]$fg
        focused = ($fg -eq $h)
        restored = ($visible -and $w -gt 40 -and $hh -gt 40)
        foreground_title = $sb.ToString()
        process = (Get-WindowProcessName $h)
        tip = if ($fg -ne $h -and $visible) {
          "Window restored/visible but OS kept another app foreground. ui_tree(hwnd=...) still works without focus."
        } elseif (-not $visible) {
          "Window still hidden - user may need to click Telegram tray icon once."
        } else { $null }
      }
    }
    "minimize" {
      $h = Find-Hwnd $req.hwnd $req.title $req.process
      if ($h -eq [IntPtr]::Zero) { throw "window not found" }
      [void][WinUiNative]::ShowWindow($h, [WinUiNative]::SW_MINIMIZE)
      Out-Json @{ ok = $true; hwnd = [int64]$h }
    }
    "maximize" {
      $h = Find-Hwnd $req.hwnd $req.title $req.process
      if ($h -eq [IntPtr]::Zero) { throw "window not found" }
      [void][WinUiNative]::ShowWindow($h, [WinUiNative]::SW_MAXIMIZE)
      Out-Json @{ ok = $true; hwnd = [int64]$h }
    }
    "close" {
      $h = Find-Hwnd $req.hwnd $req.title $req.process
      if ($h -eq [IntPtr]::Zero) { throw "window not found" }
      if (-not $req.hwnd -and -not $req.title -and -not $req.process) {
        throw "close requires hwnd|title|process"
      }
      Assert-SafeDestructive $h ([string]$req.title) ([string]$req.process)
      [void][WinUiNative]::PostMessage($h, [WinUiNative]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
      Out-Json @{ ok = $true; hwnd = [int64]$h }
    }
    "launch" {
      $target = [string]$req.target
      if (-not $target) { throw "target required" }
      if ($target -match '^[a-z][a-z0-9+\.-]*:') {
        Start-Process $target | Out-Null
      } elseif (Test-Path $target) {
        Start-Process -FilePath $target | Out-Null
      } else {
        try { Start-Process -FilePath $target | Out-Null }
        catch { Start-Process "cmd.exe" -ArgumentList "/c","start","","$target" | Out-Null }
      }
      Start-Sleep -Milliseconds 900
      $leaf = [IO.Path]::GetFileNameWithoutExtension($target)
      $wins = @(Get-WindowsList | Where-Object {
        ($leaf -and ($_.process -like "*$leaf*" -or $_.title -like "*$leaf*")) -or $_.on_screen
      } | Select-Object -First 20)
      Out-Json @{ ok = $true; launched = $target; windows = $wins }
    }
    "click" {
      $h = Find-Hwnd $req.hwnd $req.title $req.process
      if ($h -ne [IntPtr]::Zero) { Assert-NotIdeTarget $h "click" }
      if ($h -ne [IntPtr]::Zero -and $req.focus -ne $false) { Focus-Window $h }
      $c = Resolve-Coords $req $h
      $clicks = 1
      if ($req.clicks) { $clicks = [int]$req.clicks }
      Click-At ([int]$c.x) ([int]$c.y) ([string]($req.button)) $clicks
      Out-Json @{ ok = $true; x = [int]$c.x; y = [int]$c.y; button = ($req.button); clicks = $clicks }
    }
    "double_click" {
      $h = Find-Hwnd $req.hwnd $req.title $req.process
      if ($h -ne [IntPtr]::Zero -and $req.focus -ne $false) { Focus-Window $h }
      $c = Resolve-Coords $req $h
      Click-At ([int]$c.x) ([int]$c.y) ([string]($req.button)) 2
      Out-Json @{ ok = $true; x = [int]$c.x; y = [int]$c.y; clicks = 2 }
    }
    "move" {
      $h = Find-Hwnd $req.hwnd $req.title $req.process
      $c = Resolve-Coords $req $h
      Move-Mouse ([int]$c.x) ([int]$c.y)
      Out-Json @{ ok = $true; x = [int]$c.x; y = [int]$c.y }
    }
    "scroll" {
      $h = Find-Hwnd $req.hwnd $req.title $req.process
      if ($h -ne [IntPtr]::Zero -and $req.focus -ne $false) { Focus-Window $h }
      $c = Resolve-Coords $req $h
      $delta = 120
      if ($null -ne $req.delta) { $delta = [int]$req.delta }
      Scroll-At ([int]$c.x) ([int]$c.y) $delta
      Out-Json @{ ok = $true; x = [int]$c.x; y = [int]$c.y; delta = $delta }
    }
    "type" {
      $h = Find-Hwnd $req.hwnd $req.title $req.process
      if ($h -ne [IntPtr]::Zero) { Assert-NotIdeTarget $h "type" }
      if ($h -ne [IntPtr]::Zero -and $req.focus -ne $false) { Focus-Window $h }
      Type-Text ([string]$req.text)
      Out-Json @{ ok = $true; typed_len = ([string]$req.text).Length }
    }
    "keys" {
      if (-not $req.hwnd -and -not $req.title -and -not $req.process) {
        throw "keys requires hwnd|title|process - refusing global SendKeys"
      }
      $h = Find-Hwnd $req.hwnd $req.title $req.process
      if ($h -eq [IntPtr]::Zero) { throw "window not found - refusing SendKeys" }
      Assert-NotIdeTarget $h "keys"
      $keyStr = [string]$req.keys
      if (Test-IsQuitKeys $keyStr) {
        Assert-SafeDestructive $h ([string]$req.title) ([string]$req.process) $keyStr
      }
      Focus-Window $h
      $fg = [WinUiNative]::GetForegroundWindow()
      if ($fg -ne $h) { throw "focus failed - refusing SendKeys (would hit wrong app)" }
      Send-KeysSafe $keyStr
      Out-Json @{ ok = $true; keys = $keyStr; hwnd = [int64]$h }
    }
    "find" {
      $h = Find-Hwnd $req.hwnd $req.title $req.process
      if ($h -eq [IntPtr]::Zero) { $h = [WinUiNative]::GetForegroundWindow() }
      if ($req.focus -eq $true) { Focus-Window $h }
      $el = Find-UiElement $h ([string]$req.name) ([string]$req.automation_id) ([string]$req.control_type)
      if (-not $el) { throw "element not found" }
      Out-Json @{ ok = $true; hwnd = [int64]$h; element = (Element-Info $el) }
    }
    "click_element" {
      $h = Find-Hwnd $req.hwnd $req.title $req.process
      if ($h -eq [IntPtr]::Zero) { $h = [WinUiNative]::GetForegroundWindow() }
      Assert-NotIdeTarget $h "click_element"
      $elName = [string]$req.name
      if ($elName -match '(?i)^(close|x)$') {
        throw "REFUSED: click_element name looks like a Close control - blocked"
      }
      Focus-Window $h
      $el = Find-UiElement $h $elName ([string]$req.automation_id) ([string]$req.control_type)
      if (-not $el) { throw "element not found" }
      $how = Invoke-UiElement $el
      Out-Json @{ ok = $true; hwnd = [int64]$h; how = $how; element = (Element-Info $el); process = (Get-WindowProcessName $h) }
    }
    "set_value" {
      $h = Find-Hwnd $req.hwnd $req.title $req.process
      if ($h -eq [IntPtr]::Zero) { $h = [WinUiNative]::GetForegroundWindow() }
      Focus-Window $h
      $el = Find-UiElement $h ([string]$req.name) ([string]$req.automation_id) ([string]$req.control_type)
      if (-not $el) { throw "element not found" }
      $val = [string]$req.text
      $how = "type"
      try {
        $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if ($vp) { $vp.SetValue($val); $how = "ValuePattern" }
      } catch {}
      if ($how -eq "type") {
        $info = Element-Info $el
        Click-At ([int]$info.cx) ([int]$info.cy) "left" 1
        Start-Sleep -Milliseconds 80
        Send-KeysSafe "^a"
        Type-Text $val
        Out-Json @{ ok = $true; how = $how; element = $info }
      } else {
        Out-Json @{ ok = $true; how = $how; element = (Element-Info $el) }
      }
    }
    "ui_tree" {
      $h = Find-Hwnd $req.hwnd $req.title $req.process
      if ($h -eq [IntPtr]::Zero) { $h = [WinUiNative]::GetForegroundWindow() }
      # Do NOT force focus by default - focus steals + bad clicks killed Telegram/IDE.
      # Pass focus=true only when the agent explicitly wants the window foreground.
      $didFocus = $false
      $focused = $false
      if ($req.focus -eq $true) {
        Focus-Window $h
        $didFocus = $true
        $focused = ([WinUiNative]::GetForegroundWindow() -eq $h)
      }
      $depth = Safe-Int $req.max_depth 3
      if ($depth -lt 1) { $depth = 1 }
      if ($depth -gt 6) { $depth = 6 }
      $nodes = Get-UiTree $h $depth 120
      $proc = Get-WindowProcessName $h
      Out-Json @{
        ok = $true
        hwnd = [int64]$h
        process = $proc
        max_depth = $depth
        node_count = @($nodes).Count
        nodes = @($nodes)
        focus_requested = $didFocus
        focused = $focused
        note = if (-not $didFocus) { "tree from hwnd without focus steal; pass focus=true only if needed" } else { $null }
      }
    }
    "screenshot" {
      $path = [string]$req.path
      if (-not $path) { $path = Join-Path $env:TEMP ("ollamacode-ui-" + [guid]::NewGuid().ToString("n") + ".png") }
      $h = Find-Hwnd $req.hwnd $req.title $req.process
      if ($req.window_only -eq $true -and $h -eq [IntPtr]::Zero) { $h = [WinUiNative]::GetForegroundWindow() }
      if ($req.window_only -ne $true) { $h = [IntPtr]::Zero }
      $saved = Capture-Shot $path $h
      $fg = [WinUiNative]::GetForegroundWindow()
      $sb = New-Object System.Text.StringBuilder 512
      [void][WinUiNative]::GetWindowText($fg, $sb, $sb.Capacity)
      Out-Json @{
        ok = $true
        path = $saved
        screen = (Get-ScreenSize)
        foreground_hwnd = [int64]$fg
        foreground_title = $sb.ToString()
        windows = @(Get-WindowsList | Where-Object { $_.on_screen } | Select-Object -First 25)
        note = "PNG saved on disk. Text models cannot see pixels; use ui_tree/list_windows/find for structure, or click by coordinates from nodes."
      }
    }
    "snapshot" {
      # One-shot orientation: screen + foreground + windows (optional title/process filter)
      $fg = [WinUiNative]::GetForegroundWindow()
      $sb = New-Object System.Text.StringBuilder 512
      [void][WinUiNative]::GetWindowText($fg, $sb, $sb.Capacity)
      $fgPid = [uint32]0
      [void][WinUiNative]::GetWindowThreadProcessId($fg, [ref]$fgPid)
      $fgProc = ""
      try { $fgProc = (Get-Process -Id $fgPid -EA SilentlyContinue).ProcessName } catch {}
      $all = @(Get-WindowsList)
      $wins = Filter-WindowsList $all $req
      $matchHwnd = [IntPtr]::Zero
      if ($req.hwnd -or $req.title -or $req.process) {
        $matchHwnd = Find-Hwnd $req.hwnd $req.title $req.process
      }
      $matchProc = if ($matchHwnd -ne [IntPtr]::Zero) { Get-WindowProcessName $matchHwnd } else { "" }
      $matchTitle = ""
      $matchOnScreen = $false
      if ($matchHwnd -ne [IntPtr]::Zero) {
        $msb = New-Object System.Text.StringBuilder 512
        [void][WinUiNative]::GetWindowText($matchHwnd, $msb, $msb.Capacity)
        $matchTitle = $msb.ToString()
        $mr = New-Object WinUiNative+RECT
        [void][WinUiNative]::GetWindowRect($matchHwnd, [ref]$mr)
        $mw = [Math]::Max(0, $mr.Right - $mr.Left)
        $mh = [Math]::Max(0, $mr.Bottom - $mr.Top)
        $matchOnScreen = ([WinUiNative]::IsWindowVisible($matchHwnd) -and $mw -gt 40 -and $mh -gt 40)
      }
      $procAlive = $false
      if ($req.process) {
        $procAlive = [bool](Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like "*$($req.process)*" } | Select-Object -First 1)
      }
      Out-Json @{
        ok = $true
        screen = (Get-ScreenSize)
        foreground = @{ hwnd = [int64]$fg; title = $sb.ToString(); pid = $fgPid; process = $fgProc }
        count = @($wins).Count
        windows = @($wins | Select-Object -First 40)
        filter = @{ title = [string]$req.title; process = [string]$req.process }
        process_alive = $procAlive
        match = if ($matchHwnd -ne [IntPtr]::Zero) {
          @{ hwnd = [int64]$matchHwnd; process = $matchProc; title = $matchTitle; on_screen = $matchOnScreen }
        } else { $null }
        tip = if ($matchHwnd -ne [IntPtr]::Zero -and -not $matchOnScreen) {
          "Process found but window is trayed/hidden. Call focus(hwnd=match.hwnd) to restore, then ui_tree."
        } elseif ($procAlive -and $matchHwnd -eq [IntPtr]::Zero) {
          "Process is alive but no hwnd yet. Ask user to open Telegram window, or launch it."
        } else {
          "Next: focus(hwnd=<match.hwnd or pick>) then ui_tree(hwnd=..., max_depth=3). Do NOT use screenshot to see UI."
        }
      }
    }
    "clipboard_get" {
      $t = ""
      try { $t = [System.Windows.Forms.Clipboard]::GetText() } catch {}
      Out-Json @{ ok = $true; text = $t; length = $t.Length }
    }
    "clipboard_set" {
      [System.Windows.Forms.Clipboard]::SetText([string]$req.text)
      Out-Json @{ ok = $true; length = ([string]$req.text).Length }
    }
    "wait" {
      $ms = 500
      if ($req.ms) { $ms = [int]$req.ms }
      $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(50, $ms))
      $found = $false
      $payload = @{ ok = $true; found = $false; waited_ms = $ms }
      do {
        $h = Find-Hwnd $req.hwnd $req.title $req.process
        if ($h -ne [IntPtr]::Zero) {
          if ($req.name -or $req.automation_id) {
            $el = Find-UiElement $h ([string]$req.name) ([string]$req.automation_id) ([string]$req.control_type)
            if ($el) {
              $payload = @{ ok = $true; found = $true; hwnd = [int64]$h; element = (Element-Info $el) }
              $found = $true
              break
            }
          } else {
            $payload = @{ ok = $true; found = $true; hwnd = [int64]$h }
            $found = $true
            break
          }
        }
        Start-Sleep -Milliseconds 120
      } while (-not $found -and [DateTime]::UtcNow -lt $deadline)
      Out-Json $payload
    }
    default { throw "unknown action: $action" }
  }
} catch {
  Out-Json @{ ok = $false; error = $_.Exception.Message }
  exit 1
}
