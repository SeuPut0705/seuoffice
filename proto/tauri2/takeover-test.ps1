# Windows runner only: the shipped Electron build (SeuOffice-Setup-<tag>.exe) is installed per user,
# %APPDATA%\seuoffice gets a marker, then this prototype's installer runs the way electron-updater
# starts it (--updated /S --force-run). Checks: one SeuOffice entry in the app list under the key the
# Electron installer made, the same folder with the new exe and no Electron left, .docx still opens
# through seuoffice.WordDocument, the marker untouched, the app started by the installer; then a
# positional .docx launch and the uninstaller. Prints the registry dumps the acceptance asks for.
#   takeover-test.ps1 -Electron <exe> -Installer <exe> -Out <dir> -Doc <docx>
param([string]$Electron, [string]$Installer, [string]$Out, [string]$Doc)
$ErrorActionPreference = 'Continue'
# absolute: the app the installer starts runs in the install folder, where a relative BENCH_OUT would not resolve
$Out = (New-Item -ItemType Directory -Force -Path $Out).FullName
$ud = Join-Path $env:APPDATA 'seuoffice'
$root = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$problems = New-Object System.Collections.Generic.List[string]
function Check($ok, $what) { if ($ok) { Write-Host "ok    $what" } else { Write-Host "FAIL  $what"; $problems.Add($what) } }

function Entries {
  Get-ChildItem $root | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath
    if ($p.DisplayName -like 'SeuOffice*') {
      [pscustomobject]@{ Key = $_.PSChildName; DisplayName = $p.DisplayName; DisplayVersion = $p.DisplayVersion
        InstallLocation = $p.InstallLocation; UninstallString = $p.UninstallString; MainBinaryName = $p.MainBinaryName }
    }
  }
}
function Dump($label) {
  Write-Host "=== $label"
  foreach ($k in 'HKCU\Software\Classes\.docx', 'HKCU\Software\Classes\seuoffice.WordDocument', 'HKCU\Software\seuoffice\Capabilities') {
    Write-Host "--- reg query $k /s"
    reg query $k /s 2>&1 | Write-Host
  }
  foreach ($k in @(Entries)) {
    Write-Host "--- reg query HKCU\Software\$($k.Key) (electron-builder's install key)"
    reg query "HKCU\Software\$($k.Key)" 2>&1 | Write-Host
  }
  Write-Host '--- uninstall keys named SeuOffice'
  Get-ChildItem $root | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath
    if ($p.DisplayName -like 'SeuOffice*') {
      Write-Host "reg query HKCU\...\Uninstall\$($_.PSChildName)"
      reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\$($_.PSChildName)" 2>&1 | Write-Host
    }
  }
}
function Stop-Installed($dir) {
  Get-Process | Where-Object { $_.Path -and $dir -and $_.Path.StartsWith($dir) } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep 2
}

Write-Host "=== installing the Electron build $Electron"
$p = Start-Process -FilePath $Electron -ArgumentList '/S', '/currentuser' -PassThru -Wait
Write-Host "Electron installer exit $($p.ExitCode)"
$before = @(Entries)
$entry = $before | Select-Object -First 1
Check ($before.Count -eq 1) "one SeuOffice entry after the Electron install ($($before.Count))"
$installDir = $entry.InstallLocation
if (-not $installDir) {
  Write-Host 'InstallLocation is not in the uninstall key; the uninstaller folder is the fallback'
  $installDir = Split-Path ($entry.UninstallString -replace '^"([^"]+)".*$', '$1')
}
Write-Host "Electron install dir: $installDir (uninstall key $($entry.Key))"
$electronFiles = @(Get-ChildItem $installDir -Name)
Write-Host ("Electron files: " + ($electronFiles -join ', '))
Check ($electronFiles -contains 'SeuOffice.exe') 'the Electron install has SeuOffice.exe'

New-Item -ItemType Directory -Force -Path $ud | Out-Null
Set-Content -Path (Join-Path $ud 'marker.txt') -Value 'userData written by the Electron build'
Set-Content -Path (Join-Path $ud 'Preferences') -Value '{"seuoffice":"settings"}'
$hashBefore = (Get-FileHash -Algorithm SHA256 (Join-Path $ud 'marker.txt')).Hash
Dump 'before the prototype installer'

$startupOut = Join-Path $Out 'force-run.jsonl'
Remove-Item -Force -ErrorAction SilentlyContinue $startupOut, (Join-Path $ud 'proto-shell-started.json')
$env:BENCH_OUT = $startupOut
$sw = [Diagnostics.Stopwatch]::StartNew()
# -Wait would also wait for the app the installer starts (it waits for descendants), electron-updater does not
$p = Start-Process -FilePath $Installer -ArgumentList '--updated', '/S', '--force-run' -PassThru
if (-not $p.WaitForExit(180000)) { $p.Kill(); $problems.Add('the installer did not finish in 180 s') }
$seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
Remove-Item Env:\BENCH_OUT
Write-Host "prototype installer exit $($p.ExitCode) in $seconds s"
Check ($p.ExitCode -eq 0) 'the installer exits 0'

$started = $null
for ($i = 0; $i -lt 90 -and -not $started; $i++) {
  $f = Join-Path $ud 'proto-shell-started.json'
  if (Test-Path $f) { $started = Get-Content -Raw $f | ConvertFrom-Json } else { Start-Sleep 1 }
}
Start-Sleep 3
Write-Host '--- installer log (%TEMP%\seuoffice-proto-installer.log)'
Get-Content (Join-Path $env:TEMP 'seuoffice-proto-installer.log') -ErrorAction SilentlyContinue | Write-Host
Write-Host '--- SeuOffice processes'
Get-Process SeuOffice -ErrorAction SilentlyContinue | Format-Table Id, Path | Out-String | Write-Host
Get-WinEvent -LogName Application -MaxEvents 15 -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'SeuOffice' } | ForEach-Object { Write-Host $_.Message }
Dump 'after the prototype installer'
$after = @(Entries)
$afterFiles = @(Get-ChildItem $installDir -Name -ErrorAction SilentlyContinue)
Write-Host ("Files after: " + ($afterFiles -join ', '))
$exe = Join-Path $installDir 'SeuOffice.exe'
Check ($after.Count -eq 1) "one SeuOffice entry after the update ($($after.Count))"
Check ($after[0].Key -eq $entry.Key) 'the entry keeps the Electron-time key name'
Check ($after[0].UninstallString -like '*uninstall.exe*' -and $after[0].UninstallString -like "*$installDir*") 'the entry points at the new uninstaller in the same folder'
Check ($after[0].DisplayVersion -eq '0.13.0') 'DisplayVersion is 0.13.0'
Check ((Test-Path $exe) -and ((Get-Item $exe).VersionInfo.ProductVersion -like '0.13.0*')) 'SeuOffice.exe in the same folder is the new one'
Check (-not ($afterFiles -contains 'locales' -or $afterFiles -contains 'resources' -or $afterFiles -contains 'ffmpeg.dll' -or ($afterFiles | Where-Object { $_ -like '*.pak' }))) 'no Electron files are left'
$docx = (Get-Item 'HKCU:\Software\Classes\.docx' -ErrorAction SilentlyContinue).GetValue('')
Check ($docx -eq 'seuoffice.WordDocument') ".docx default is seuoffice.WordDocument ($docx)"
$cmd = (Get-Item 'HKCU:\Software\Classes\seuoffice.WordDocument\shell\open\command' -ErrorAction SilentlyContinue).GetValue('')
Check ($cmd -like "*$exe*") "seuoffice.WordDocument opens with the new exe ($cmd)"
Check ((Get-FileHash -Algorithm SHA256 (Join-Path $ud 'marker.txt')).Hash -eq $hashBefore) 'the userData marker is unchanged'
Check (Test-Path (Join-Path $ud 'Preferences')) 'the userData settings file is still there'
Check ($null -ne $started -and ($started.args -contains '--updated')) 'the installer started the new app with --updated (--force-run)'
Write-Host ('proto-shell-started.json: ' + ($started | ConvertTo-Json -Compress))
if (Test-Path $startupOut) { Write-Host 'startup line of the app the installer started:'; Get-Content $startupOut | Write-Host }
Stop-Installed $installDir

Write-Host '=== positional .docx launch'
$posOut = Join-Path $Out 'positional.jsonl'
Remove-Item -Force -ErrorAction SilentlyContinue $posOut
$env:BENCH_OUT = $posOut
$app = Start-Process -FilePath $exe -ArgumentList "`"$Doc`"" -PassThru
$line = $null
for ($i = 0; $i -lt 60 -and -not $line; $i++) {
  if (Test-Path $posOut) { $line = Get-Content $posOut | Select-Object -First 1 } else { Start-Sleep 1 }
}
Remove-Item Env:\BENCH_OUT
Write-Host "startup line: $line"
$cfg = if ($line) { ($line | ConvertFrom-Json).config } else { $null }
Check ($null -ne $cfg -and $cfg.mode -eq 'interactive' -and $cfg.doc -eq $Doc) 'a positional .docx opens in interactive mode'
Stop-Installed $installDir

Write-Host '=== uninstall'
$uninstaller = Join-Path $installDir 'uninstall.exe'
if (Test-Path $uninstaller) {
  $u = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
  Start-Sleep 3
  Write-Host "uninstaller exit $($u.ExitCode)"
} else { Check $false "uninstall.exe exists in $installDir" }
Dump 'after the uninstaller'
Check (@(Entries).Count -eq 0) 'no SeuOffice entry after the uninstall'
Check (Test-Path (Join-Path $ud 'marker.txt')) 'the userData marker survives the uninstall'

$result = [ordered]@{
  electronInstallDir = $installDir; electronKey = $entry.Key; installerSeconds = $seconds
  entriesBefore = $before; entriesAfter = $after; filesBefore = $electronFiles; filesAfter = $afterFiles
  started = $started; problems = @($problems)
}
$result | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $Out 'takeover.json') -Encoding utf8
if ($problems.Count) { Write-Host "TAKEOVER FAILED: $($problems -join '; ')"; exit 1 }
Write-Host 'TAKEOVER OK'
