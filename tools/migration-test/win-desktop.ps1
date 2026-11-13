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
  [ValidateSet('none', 'kill-installer', 'block-start')] [string]$Fault = 'none',
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
  if (Test-Path $exe) { (Get-Item $exe).VersionInfo.ProductVersion } else { $null }
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
  gh release download $From --repo SeuPut0705/seuoffice --dir $dl --pattern 'SeuOffice-Setup-*.exe' --clobber
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
  if ($Fault -eq 'block-start') {
    New-Item -Force -Path $ifeo | Out-Null
    Set-ItemProperty -Path $ifeo -Name Debugger -Value 'C:\migration-test\no-such-debugger.exe'
  }
  StartApp @()
  $installersBefore = @(Get-Process | ForEach-Object Id)
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
  if ($Fault -eq 'kill-installer' -and $installer) {
    Start-Sleep 5
    Stop-Process -Id $installer.Id -Force
    Step 'installer-killed' @{ }
  } elseif ($installer) {
    $installer.WaitForExit()
  }
  for ($i = 0; $i -lt 90 -and -not (AppProcesses); $i++) { Start-Sleep 1 }
  Start-Sleep 5
  $started = [bool](AppProcesses)
  if ($Fault -eq 'block-start') { Remove-Item -Force -Path $ifeo }
  StopApp
  $version = ExeVersion
  Step 'after-install' @{ version = $version; appStartedByInstaller = $started; seconds = $t.Elapsed.TotalSeconds }

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
    & node (Join-Path $here 'probe.mjs') update --port $Port --version $NextVersion
    if ($LASTEXITCODE -ne 0) { Fail 'the second update did not reach "downloaded"' }
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
  if ($script:feed) { Stop-Process -Id $script:feed.Id -Force -ErrorAction SilentlyContinue }
  StopApp
  Save
}
