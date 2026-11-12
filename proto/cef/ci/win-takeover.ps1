# Installs the shipped Electron 0.12.37 per user, puts userData markers where
# the app keeps them, runs the prototype installer the way electron-updater
# does (SeuOffice-Setup-0.13.0.exe --updated /S --force-run) and checks what
# proto/README.md asks for. Prints a registry dump before and after.
#   win-takeover.ps1 -Installer <exe> -OutDir <dir>
param(
  [Parameter(Mandatory)] [string] $Installer,
  [Parameter(Mandatory)] [string] $OutDir
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$failures = New-Object System.Collections.Generic.List[string]
function Fail($msg) { Write-Host "TAKEOVER FAIL: $msg"; $failures.Add($msg) }

$uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$userData = Join-Path $env:APPDATA 'seuoffice'
$defaultDir = Join-Path $env:LOCALAPPDATA 'Programs\SeuOffice'

function Dump-Registry($label) {
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("===== $label =====")
  Get-ChildItem $uninstallRoot -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath
    if ($p.DisplayName -like 'SeuOffice*') {
      $lines.Add("[Uninstall\$($_.PSChildName)]")
      $p.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { $lines.Add("  $($_.Name) = $($_.Value)") }
    }
  }
  foreach ($key in @(
      'HKCU:\Software\Classes\.docx', 'HKCU:\Software\Classes\seuoffice.WordDocument',
      'HKCU:\Software\Classes\seuoffice.WordDocument\DefaultIcon',
      'HKCU:\Software\Classes\seuoffice.WordDocument\shell\open\command',
      'HKCU:\Software\RegisteredApplications', 'HKCU:\Software\seuoffice\Capabilities\FileAssociations')) {
    if (Test-Path $key) {
      $lines.Add("[$key]")
      (Get-ItemProperty $key).PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { $lines.Add("  $($_.Name) = $($_.Value)") }
    } else {
      $lines.Add("[$key] (absent)")
    }
  }
  $lines
}

# 1. the shipped Electron app, per user
$electron = Join-Path $env:RUNNER_TEMP 'SeuOffice-Setup-0.12.37.exe'
gh release download v0.12.37 -R SeuPut0705/seuoffice -p 'SeuOffice-Setup-0.12.37.exe' -D $env:RUNNER_TEMP --clobber
if ($LASTEXITCODE -ne 0) { throw 'cannot download the Electron installer' }
$t = Get-Date
$ep = Start-Process -FilePath $electron -ArgumentList '/S', '/currentuser' -PassThru -Wait
Write-Host ("electron-builder installer exit code {0}, {1:n0}s" -f $ep.ExitCode, ((Get-Date) - $t).TotalSeconds)
Write-Host "per-user dir present: $(Test-Path $defaultDir); Program Files dir present: $(Test-Path 'C:\Program Files\SeuOffice')"
foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
  Get-ChildItem $root -ErrorAction SilentlyContinue | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like '*SeuOffice*' } | ForEach-Object { Write-Host "uninstall key: $($_.Name)" }
}
$oldKey = Get-ChildItem $uninstallRoot | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like 'SeuOffice*' } | Select-Object -First 1
if (-not $oldKey) { throw 'the Electron installer left no uninstall key with DisplayName SeuOffice' }
$oldProps = Get-ItemProperty $oldKey.PSPath
Write-Host "Electron uninstall key: $($oldKey.PSChildName) InstallLocation=$($oldProps.InstallLocation) Version=$($oldProps.DisplayVersion)"
$oldDir = $oldProps.InstallLocation
if (-not (Test-Path (Join-Path $oldDir 'resources\app.asar'))) { Fail 'the Electron install has no resources\app.asar' }

# 2. userData markers an existing user would have
New-Item -ItemType Directory -Force -Path $userData | Out-Null
'{"os_crypt":{"encrypted_key":"RFBBUEkgbWFya2Vy"}}' | Set-Content -Path (Join-Path $userData 'Local State') -NoNewline
'{"theme":"dark","marker":"settings-kept"}' | Set-Content -Path (Join-Path $userData 'settings.json') -NoNewline
'["C:\\docs\\recent-1.docx"]' | Set-Content -Path (Join-Path $userData 'recent-files.json') -NoNewline
$before = @{}
Get-ChildItem $userData -File | ForEach-Object { $before[$_.Name] = (Get-FileHash $_.FullName).Hash }

Dump-Registry 'before the prototype installer' | Tee-Object -FilePath (Join-Path $OutDir 'registry-before.txt')

# 3. the move-over, exactly as electron-updater calls it
$t = Get-Date
$proc = Start-Process -FilePath $Installer -ArgumentList '--updated', '/S', '--force-run' -PassThru -Wait
Write-Host ("prototype installer exit code {0}, {1:n0}s" -f $proc.ExitCode, ((Get-Date) - $t).TotalSeconds)
if ($proc.ExitCode -ne 0) { Fail "installer exit code $($proc.ExitCode)" }

# --force-run must have started the app: it writes proto-shell-started.json
$noteFile = Join-Path $userData 'proto-shell-started.json'
$deadline = (Get-Date).AddSeconds(90)
while (-not (Test-Path $noteFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
if (Test-Path $noteFile) {
  Write-Host "force-run started the app: $(Get-Content $noteFile -Raw)"
} else {
  Fail '--force-run did not start the app (no proto-shell-started.json)'
}
Start-Sleep -Seconds 5
Get-Process -Name SeuOffice -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3

# 4. what the contract asks
$new = Get-ChildItem $uninstallRoot | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like 'SeuOffice*' }
if (@($new).Count -ne 1) { Fail "expected one SeuOffice uninstall key, found $(@($new).Count)" }
if (@($new).Count -ge 1) {
  $np = Get-ItemProperty @($new)[0].PSPath
  Write-Host "uninstall key now: $(@($new)[0].PSChildName) DisplayVersion=$($np.DisplayVersion) InstallLocation=$($np.InstallLocation) UninstallString=$($np.UninstallString)"
  if ($np.DisplayVersion -ne '0.13.0') { Fail "DisplayVersion $($np.DisplayVersion)" }
  $newDir = $np.InstallLocation.Trim('"')
  if ($newDir -ne $oldDir) { Fail "installed into $newDir, the Electron install was in $oldDir" }
} else { $newDir = $oldDir }
$exe = Join-Path $newDir 'SeuOffice.exe'
if (-not (Test-Path $exe)) { Fail "no $exe" }
if (Test-Path (Join-Path $newDir 'resources\app.asar')) { Fail 'Electron payload (resources\app.asar) is still there' }
if (-not (Test-Path (Join-Path $newDir 'libcef.dll'))) { Fail 'no libcef.dll next to the executable' }
if (Test-Path (Join-Path $newDir 'Uninstall SeuOffice.exe')) { Fail 'the Electron uninstaller is still there' }
if (-not (Test-Path (Join-Path $newDir 'uninstall.exe'))) { Fail 'no uninstall.exe of the new installer' }
$docx = (Get-ItemProperty 'HKCU:\Software\Classes\.docx' -ErrorAction SilentlyContinue).'(default)'
if ($docx -ne 'seuoffice.WordDocument') { Fail ".docx default is '$docx'" }
$cmd = (Get-ItemProperty 'HKCU:\Software\Classes\seuoffice.WordDocument\shell\open\command' -ErrorAction SilentlyContinue).'(default)'
Write-Host "seuoffice.WordDocument open command: $cmd"
if (-not $cmd -or $cmd -notlike "*$exe*") { Fail "WordDocument open command does not point at $exe" }
foreach ($name in $before.Keys) {
  $file = Join-Path $userData $name
  if (-not (Test-Path $file)) { Fail "userData lost $name" }
  elseif ((Get-FileHash $file).Hash -ne $before[$name]) { Fail "userData changed $name" }
}
$shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\SeuOffice.lnk'
Write-Host "Start menu shortcut present: $(Test-Path $shortcut)"

Dump-Registry 'after the prototype installer' | Tee-Object -FilePath (Join-Path $OutDir 'registry-after.txt')
Get-ChildItem $newDir | Select-Object Name, Length | Format-Table -AutoSize | Out-String | Write-Host
Set-Content -Path (Join-Path $OutDir 'installed-exe.txt') -Value $exe -NoNewline

if ($failures.Count -gt 0) { Write-Host "TAKEOVER FAILED: $($failures -join '; ')"; exit 1 }
Write-Host 'TAKEOVER OK'
