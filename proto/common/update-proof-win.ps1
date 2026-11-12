# Proof (a)+(c) on Windows, runner only: the shipped Electron app v0.12.37 is
# installed per user (SeuOffice-Setup-0.12.37.exe /S) and has run once
# (real-app.py). The candidate's installer then runs exactly as electron-updater
# 6 starts it after "Restart and install" (NsisUpdater: --updated, /S when
# silent, --force-run), with the old app already closed. Then: one SeuOffice
# entry in the uninstall list pointing at the new uninstaller, the same install
# folder with the new exe and no Electron left, .docx still opening through
# seuoffice.WordDocument with the new exe, %APPDATA%\seuoffice unchanged, and
# the new app started by the installer.
#   update-proof-win.ps1 -Installer <exe> -Shell <name> -Out <dir>
param([string]$Installer, [string]$Shell, [string]$Out)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$ud = Join-Path $env:APPDATA 'seuoffice'
$uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'

function Hashes {
  Get-ChildItem -Recurse -File $ud |
    Where-Object { $_.Name -ne 'proto-shell-started.json' -and $_.FullName -notmatch '\\Crashpad\\' } |
    ForEach-Object { '{0} {1}' -f (Get-FileHash -Algorithm SHA256 $_.FullName).Hash, $_.FullName.Substring($ud.Length) } |
    Sort-Object
}
function Entries {
  Get-ChildItem $uninstallRoot | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath
    if ($p.DisplayName -like 'SeuOffice*' -or $p.DisplayName -like 'seuoffice*') {
      [ordered]@{ key = $_.PSChildName; DisplayName = $p.DisplayName; DisplayVersion = $p.DisplayVersion;
        InstallLocation = $p.InstallLocation; UninstallString = $p.UninstallString }
    }
  }
}
function Classes {
  $o = [ordered]@{}
  foreach ($k in '.docx', '.docx\OpenWithProgids', 'seuoffice.WordDocument\shell\open\command', 'seuoffice.WordDocument\DefaultIcon') {
    $path = "HKCU:\Software\Classes\$k"
    if (Test-Path $path) {
      $item = Get-Item $path
      $vals = [ordered]@{}
      foreach ($n in $item.GetValueNames()) { $vals[$(if ($n) { $n } else { '(default)' })] = [string]$item.GetValue($n) }
      $o[$k] = $vals
    } else { $o[$k] = $null }
  }
  $o
}

Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $ud 'proto-shell-started.json')
$before = [ordered]@{ entries = @(Entries); classes = Classes }
Hashes | Set-Content (Join-Path $Out 'userdata-before.txt')
# electron-builder keeps the folder under HKCU\Software\<key>, not in the uninstall entry
$entry = $before.entries | Select-Object -First 1
$installDir = $null
if ($entry) {
  $installDir = (Get-ItemProperty "HKCU:\Software\$($entry.key)" -ErrorAction SilentlyContinue).InstallLocation
  if (-not $installDir -and $entry.UninstallString -match '^"?([^"]+)\\[^\\"]+"?') { $installDir = $Matches[1] }
}
if (-not $installDir) { $installDir = Join-Path $env:LOCALAPPDATA 'Programs\SeuOffice' }
$beforeFiles = if ($installDir) { Get-ChildItem $installDir | ForEach-Object Name } else { @() }

$t = [Diagnostics.Stopwatch]::StartNew()
# not -Wait: it also waits for the app the installer starts with --force-run
$p = Start-Process -FilePath $Installer -ArgumentList '--updated', '/S', '--force-run' -PassThru
$p.WaitForExit()
$installerSeconds = [math]::Round($t.Elapsed.TotalSeconds, 1)
$started = $null
for ($i = 0; $i -lt 90 -and -not $started; $i++) {
  $f = Join-Path $ud 'proto-shell-started.json'
  if (Test-Path $f) { $started = Get-Content -Raw $f | ConvertFrom-Json } else { Start-Sleep 1 }
}
Start-Sleep 3
$after = [ordered]@{ entries = @(Entries); classes = Classes }
$afterFiles = if ($installDir -and (Test-Path $installDir)) { Get-ChildItem $installDir | ForEach-Object Name } else { @() }
Get-Process | Where-Object { $_.Path -and $installDir -and $_.Path.StartsWith($installDir) } | Stop-Process -Force
Start-Sleep 2
Hashes | Set-Content (Join-Path $Out 'userdata-after.txt')
$same = -not (Compare-Object (Get-Content (Join-Path $Out 'userdata-before.txt')) (Get-Content (Join-Path $Out 'userdata-after.txt')))

$result = [ordered]@{
  shell = $Shell
  installerExit = $p.ExitCode
  installerSeconds = $installerSeconds
  installDirBefore = $installDir
  installDirFilesBefore = $beforeFiles
  installDirFilesAfter = $afterFiles
  before = $before
  after = $after
  newAppStarted = $started
  userDataFiles = (Get-Content (Join-Path $Out 'userdata-before.txt')).Count
  userDataUnchanged = $same
}
$json = $result | ConvertTo-Json -Depth 8
Set-Content -Path (Join-Path $Out 'update-proof.json') -Value $json -Encoding utf8
$json
