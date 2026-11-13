# The migration acceptance test of decision 0029 on Windows: a real desktop
# (by hand, docs/seuoffice/3단계-넘어가기-시험.md) or a runner
# (.github/workflows/seuoffice-migration.yml). One run is one path:
#
#   install the Electron release -From, open a mock document, seed data
#   (seed); point its updater at a local feed offering -To; update through
#   the app's own dialog (update); check the updated app shows the same data
#   (check); optionally update again to -Next from the new app.
#
# -Fault makes the update fail on purpose; the run then checks that the old
# Electron build still starts with its data:
#   kill-installer  end the installer a few seconds after it starts
#   block-start     the updated exe cannot start (an Image File Execution
#                   Options debugger that does not exist; needs an
#                   administrator, otherwise the run reports it skipped)
#   lock-file       a file inside the old install stays open (no delete share,
#                   as an antivirus scan or a viewer holds it) for the whole
#                   update; the old version must stay installed and start
#
#   win-desktop.ps1 -From v0.12.20 -To C:\b\SeuOffice-Setup-0.13.0.exe -ToVersion 0.13.0 `
#     [-Next C:\b\SeuOffice-Setup-0.13.1.exe -NextVersion 0.13.1] [-Fault none] -Out C:\mig\run1
#
# It installs and uninstalls SeuOffice for the current user. On a machine
# that already has it, it stops unless -Force (the data in %APPDATA%\seuoffice
# would be used and changed).
param(
  [Parameter(Mandatory)] [string]$From,
  [Parameter(Mandatory)] [string]$To,
  [Parameter(Mandatory)] [string]$ToVersion,
  [string]$Next,
  [string]$NextVersion,
  [ValidateSet('none', 'kill-installer', 'block-start', 'lock-file')] [string]$Fault = 'none',
  [Parameter(Mandatory)] [string]$Out,
  [int]$Port = 9229,
  [int]$FeedPort = 8765,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$ud = Join-Path $env:APPDATA 'seuoffice'
$result = [ordered]@{ from = $From; to = $ToVersion; next = $NextVersion; fault = $Fault; steps = @() }

function Step($name, $data) {
  $script:result.steps += [ordered]@{ step = $name; at = (Get-Date).ToString('o'); data = $data }
  Write-Host "== $name"
}
function Save {
  $script:result | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 (Join-Path $Out 'result.json')
}
function Fail($message) {
  $script:result.failure = $message
  Save
  throw $message
}
function Probe([string[]]$arguments) {
  & node (Join-Path $here 'probe.mjs') @arguments --port $Port
  if ($LASTEXITCODE -ne 0) { Fail "probe $($arguments[0]) failed" }
}
function InstallDir {
  # the key does not exist on a machine that never installed an app per user
  $entry = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like 'SeuOffice*' } | Select-Object -First 1
  if ($entry) {
    $dir = (Get-ItemProperty "HKCU:\Software\$($entry.PSChildName)" -ErrorAction SilentlyContinue).InstallLocation
    if ($dir) { return $dir }
  }
  Join-Path $env:LOCALAPPDATA 'Programs\SeuOffice'
}
function Exe { Join-Path (InstallDir) 'SeuOffice.exe' }
function ExeVersion {
  $exe = Exe
  # the exe carries x.y.z.0; the release and the app call it x.y.z
  if (Test-Path $exe) { (Get-Item $exe).VersionInfo.ProductVersion -replace '\.0$', '' } else { $null }
}
function AppProcesses {
  $dir = InstallDir
  Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($dir, 'OrdinalIgnoreCase') }
}
function StopApp {
  AppProcesses | ForEach-Object { $null = $_.CloseMainWindow() }
  for ($i = 0; $i -lt 20 -and (AppProcesses); $i++) { Start-Sleep 1 }
  AppProcesses | Stop-Process -Force
  Start-Sleep 2
}
function StartApp([string[]]$extra) {
  Start-Process -FilePath (Exe) -ArgumentList (@("--remote-debugging-port=$Port") + $extra) | Out-Null
}
function Hashes($name) {
  if (-not (Test-Path $ud)) { return }
  Get-ChildItem -Recurse -File $ud |
    Where-Object { $_.FullName -notmatch '\\(Crashpad|Cache|Code Cache|GPUCache|logs)\\' } |
    ForEach-Object { '{0} {1}' -f (Get-FileHash -Algorithm SHA256 $_.FullName).Hash, $_.FullName.Substring($ud.Length) } |
    Sort-Object | Set-Content (Join-Path $Out "userdata-$name.txt")
}
function Feed($installer, $version) {
  $dir = Join-Path $Out "feed-$version"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  & node (Join-Path $here 'feed.mjs') make --file $installer --version $version --out $dir | Out-Null
  if ($script:feed) { Stop-Process -Id $script:feed.Id -Force -ErrorAction SilentlyContinue }
  $script:feed = Start-Process node -ArgumentList (Join-Path $here 'feed.mjs'), 'serve', '--dir', $dir, '--port', $FeedPort `
    -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $Out "feed-$version.log")
  & node (Join-Path $here 'feed.mjs') point --resources (Join-Path (InstallDir) 'resources') --url "http://127.0.0.1:$FeedPort/" |
    Out-Null
}
function IsAdmin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}
# The message box the installer shows when it keeps the installed version
# (crates/shell/bundle/hooks.nsh, SeuOfficeKeepInstalled): an update from the
# app installs visibly, so the box waits for a click. Only a box of the
# installer's process with the expected text is answered (OK), never the
# installer's own window, which is a dialog too.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class MigrationDialogs {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, StringBuilder l, uint flags, uint ms, out IntPtr result);
  static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  // a top-level window's caption; GetWindowText reads no control of another process
  static string Text(IntPtr h) { var s = new StringBuilder(2048); GetWindowText(h, s, 2048); return s.ToString(); }
  // a control's text in another process: WM_GETTEXT, abort if hung, 2 s at most
  static string ControlText(IntPtr h) {
    var s = new StringBuilder(2048);
    IntPtr copied;
    if (SendMessageTimeout(h, 0x000D, (IntPtr)s.Capacity, s, 0x0002, 2000, out copied) == IntPtr.Zero) return "";
    return s.ToString();
  }
  public static string[] Answer(int pid, string mustContain) {
    var answered = new List<string>();
    EnumWindows((h, l) => {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner != (uint)pid || !IsWindowVisible(h) || Class(h) != "#32770") return true;
      var text = new StringBuilder();
      EnumChildWindows(h, (c, l2) => {
        if (Class(c) == "Static") text.Append(ControlText(c)).Append(' ');
        return true;
      }, IntPtr.Zero);
      if (text.ToString().Contains(mustContain)) {
        answered.Add(Text(h) + ": " + text.ToString().Trim());
        PostMessage(h, 0x0111, (IntPtr)1, IntPtr.Zero); // WM_COMMAND, IDOK
      }
      return true;
    }, IntPtr.Zero);
    return answered.ToArray();
  }
}
'@
$ifeo = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\SeuOffice.exe'

try {
  if ((Test-Path (Exe)) -and -not $Force) {
    Fail "SeuOffice is installed at $(InstallDir); rerun with -Force to use and change its data"
  }
  if ($Fault -eq 'block-start' -and -not (IsAdmin)) {
    $result.skipped = 'block-start needs an administrator (Image File Execution Options)'
    Save
    return
  }

  # 1. the Electron build to start from
  $dl = Join-Path $Out 'from'
  New-Item -ItemType Directory -Force -Path $dl | Out-Null
  gh release download $From --repo seuput-inc/seuoffice --dir $dl --pattern 'SeuOffice-Setup-*.exe' --clobber
  $fromExe = Get-ChildItem $dl -Filter 'SeuOffice-Setup-*.exe' | Where-Object { $_.Name -notmatch 'stable' } |
    Select-Object -First 1
  if (-not $fromExe) { Fail "no Windows installer in release $From" }
  $p = Start-Process -FilePath $fromExe.FullName -ArgumentList '/S', '/currentuser' -PassThru
  $p.WaitForExit()
  $fromVersion = ExeVersion
  Step 'installed' @{ installer = $fromExe.Name; exit = $p.ExitCode; dir = (InstallDir); version = $fromVersion }

  # 2. data the update must keep
  $doc = Join-Path $Out 'migration-test.docx'
  & node (Join-Path $here 'probe.mjs') make-docx $doc
  StartApp @($doc)
  Start-Sleep 10
  Probe @('seed', '--out', (Join-Path $Out 'seed.json'))
  StopApp
  Hashes 'seeded'
  Step 'seeded' (Get-Content -Raw (Join-Path $Out 'seed.json') | ConvertFrom-Json)

  # 3. the update, through the app's dialog
  Feed $To $ToVersion
  StartApp @()
  if ($Fault -eq 'block-start') {
    # set once the old app runs: Windows reads it when a SeuOffice.exe starts,
    # so only the one the installer starts after the update is stopped
    New-Item -Force -Path $ifeo | Out-Null
    Set-ItemProperty -Path $ifeo -Name Debugger -Value 'C:\migration-test\no-such-debugger.exe'
  }
  $installersBefore = @(Get-Process | ForEach-Object Id)
  $held = $null
  if ($Fault -eq 'lock-file') {
    # read share only: the file can be read, not renamed, moved or deleted,
    # and neither can the folder it sits in
    $target = Get-ChildItem (InstallDir) -Recurse -File |
      Where-Object { $_.Name -ne 'SeuOffice.exe' } | Select-Object -First 1
    $held = [IO.File]::Open($target.FullName, 'Open', 'Read', 'Read')
    Step 'file-held' @{ path = $target.FullName }
  }
  & node (Join-Path $here 'probe.mjs') update --port $Port --version $ToVersion
  if ($LASTEXITCODE -ne 0) { Fail 'the update did not reach "downloaded"' }
  $t = [Diagnostics.Stopwatch]::StartNew()
  $installer = $null
  for ($i = 0; $i -lt 120 -and -not $installer; $i++) {
    $installer = Get-Process | Where-Object {
      $installersBefore -notcontains $_.Id -and $_.Path -and $_.Path -match '-updater\\pending\\'
    } | Select-Object -First 1
    if (-not $installer) { Start-Sleep -Milliseconds 500 }
  }
  Step 'installer-started' @{ path = $installer.Path; seconds = $t.Elapsed.TotalSeconds }
  # read the exit code later: the handle must be taken while the process runs
  if ($installer) { $null = $installer.Handle }
  $answered = @()
  if ($Fault -eq 'kill-installer' -and $installer) {
    Start-Sleep 5
    Stop-Process -Id $installer.Id -Force
    Step 'installer-killed' @{ }
    # A killed CEF installer leaves its recovery for the next sign-in
    # (crates/shell/bundle/hooks.nsh): a RunOnce value that runs a script.
    # Do what that sign-in does: Windows deletes the value, then runs it.
    # No value means the installer was killed before it set the old version
    # aside (or an Electron installer, which has no recovery).
    $runOnce = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
    $command = (Get-ItemProperty $runOnce -ErrorAction SilentlyContinue).SeuOfficeRestorePrevious
    $script = Join-Path $env:LOCALAPPDATA 'seuoffice-restore-previous.cmd'
    $recovery = [ordered]@{ registered = [bool]$command; command = $command; script = (Test-Path $script) }
    if ($command) {
      Remove-ItemProperty $runOnce -Name SeuOfficeRestorePrevious
      & cmd.exe /c $script
      $recovery.exit = $LASTEXITCODE
      $recovery.scriptLeft = Test-Path $script
      $recovery.previousLeft = Test-Path "$(InstallDir).previous"
    }
    Step 'sign-in-recovery' $recovery
    if ($command -and ($recovery.scriptLeft -or $recovery.previousLeft)) {
      Fail 'the sign-in recovery did not put the previous version back'
    }
  } elseif ($installer) {
    # an update waits up to 90 s for the new app's start mark; 10 min is a hang
    for ($i = 0; $i -lt 1200 -and -not $installer.HasExited; $i++) {
      if ($Fault -eq 'lock-file') { $answered += [MigrationDialogs]::Answer($installer.Id, 'stays as it is') }
      Start-Sleep -Milliseconds 500
    }
    if (-not $installer.HasExited) {
      Stop-Process -Id $installer.Id -Force
      Fail 'the installer did not end within 10 minutes'
    }
    Step 'installer-ended' @{ exit = $installer.ExitCode; answered = $answered; seconds = $t.Elapsed.TotalSeconds }
  }
  for ($i = 0; $i -lt 90 -and -not (AppProcesses); $i++) { Start-Sleep 1 }
  Start-Sleep 5
  $started = [bool](AppProcesses)
  if ($Fault -eq 'block-start') { Remove-Item -Force -Path $ifeo }
  if ($held) { $held.Dispose(); $held = $null }
  StopApp
  $version = ExeVersion
  $files = if (Test-Path (InstallDir)) { @(Get-ChildItem (InstallDir) | ForEach-Object Name) } else { @() }
  Step 'after-install' @{
    version = $version; appStartedByInstaller = $started; seconds = $t.Elapsed.TotalSeconds
    installDir = (InstallDir); installDirFiles = $files
  }

  if ($Fault -eq 'lock-file') {
    # hooks.nsh: nothing written, exit code 5, the installed version started again
    if (-not $installer) { Fail 'no installer started' }
    if ($installer.ExitCode -ne 5) { Fail "the installer ended with $($installer.ExitCode), expected 5 (kept the installed version)" }
    if ($answered.Count -eq 0) { Fail 'the installer did not say it kept the installed version' }
    if (-not $started) { Fail 'the installed version was not started again' }
  }

  # 4. the data, read by the app now installed
  $expected = if ($Fault -eq 'none') { $ToVersion } else { $fromVersion }
  if ($version -ne $expected) { Fail "installed version $version, expected $expected" }
  StartApp @()
  Start-Sleep 10
  Probe @('check', '--seed', (Join-Path $Out 'seed.json'), '--version', $expected)
  StopApp
  Hashes 'checked'
  Step 'checked' @{ version = $expected }

  # 5. the new build updates itself from the same feed
  if ($Fault -eq 'none' -and $Next) {
    Feed $Next $NextVersion
    StartApp @()
    $t = [Diagnostics.Stopwatch]::StartNew()
    & node (Join-Path $here 'probe.mjs') update --port $Port --version $NextVersion
    if ($LASTEXITCODE -ne 0) { Fail 'the second update did not reach "downloaded"' }
    $downloadSeconds = $t.Elapsed.TotalSeconds
    # what the updater took from the feed: block-map ranges, or the whole file
    $name = Split-Path -Leaf $Next
    $log = @(Get-Content (Join-Path $Out "feed-$NextVersion.log") | Where-Object { $_ -match [regex]::Escape("/$name ") })
    $ranges = @($log | Where-Object { $_ -match ' range ' })
    $download = @{
      seconds = $downloadSeconds; installerBytes = (Get-Item $Next).Length
      rangeRequests = $ranges.Count
      rangeBytes = ($ranges | ForEach-Object { [long]($_ -split ' ')[-1] } | Measure-Object -Sum).Sum
      wholeFile = [bool]($log | Where-Object { $_ -notmatch ' range ' })
      blockMap = Test-Path "$Next.blockmap"
    }
    Step 'second-update-download' $download
    for ($i = 0; $i -lt 180 -and (ExeVersion) -ne $NextVersion; $i++) { Start-Sleep 1 }
    # the installer starts the new app (--force-run): stop that one, not an earlier one
    for ($i = 0; $i -lt 90 -and -not (AppProcesses); $i++) { Start-Sleep 1 }
    Start-Sleep 10
    StopApp
    StartApp @()
    Start-Sleep 10
    Probe @('check', '--seed', (Join-Path $Out 'seed.json'), '--version', $NextVersion)
    StopApp
    Step 'second-update' @{ version = (ExeVersion) }
  }
  $result.passed = $true
} finally {
  if ($Fault -eq 'block-start' -and (Test-Path $ifeo)) { Remove-Item -Force -Path $ifeo }
  if ($held) { $held.Dispose() }
  if ($script:feed) { Stop-Process -Id $script:feed.Id -Force -ErrorAction SilentlyContinue }
  StopApp
  Save
}
