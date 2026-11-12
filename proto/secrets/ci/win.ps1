# Windows proof: Electron 43.8.3 seals, open-sealed.exe (a different binary) opens via DPAPI + AES-GCM.
$ErrorActionPreference = 'Continue'
$repo = (Get-Location).Path
$work = Join-Path $env:RUNNER_TEMP 'secrets-proof'
$out = Join-Path $work 'out'
New-Item -ItemType Directory -Force $out | Out-Null
$findings = Join-Path $out 'findings.txt'
Set-Content $findings '' -Encoding utf8
function Say($m) { Write-Host $m; Add-Content $findings $m -Encoding utf8 }
function Hdr($m) { Say ''; Say "=== $m ===" }
$fail = 0

function Run-To($exe, $argList, $secs, $stdout, $stderr) {
  $p = Start-Process -FilePath $exe -ArgumentList $argList -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  if (-not $p.WaitForExit($secs * 1000)) { Stop-Process -Id $p.Id -Force; return 124 }
  return $p.ExitCode
}

function Check($label, $file) {
  $got = Get-Content $file -Raw -Encoding utf8 | ConvertFrom-Json
  $exp = Get-Content (Join-Path $repo 'proto/secrets/seed/expected.json') -Raw -Encoding utf8 | ConvertFrom-Json
  $ok = ($got.mcp -ceq $exp.mcp) -and ($got.drive -ceq $exp.drive)
  Say "[$label] PLAINTEXT CHECK: $(if ($ok) { 'EQUAL to seeded values' } else { 'DIFFERENT' })"
  if (-not $ok) { $script:fail = 1 }
}

Hdr 'environment'
Say ([System.Environment]::OSVersion.VersionString)
Say "user $env:USERNAME, APPDATA $env:APPDATA"
Say (rustc --version)

Hdr 'build the Rust crate'
Push-Location proto/secrets
cargo test --release 2>&1 | Select-Object -Last 12 | ForEach-Object { Say $_ }
cargo build --release 2>&1 | Select-Object -Last 3 | ForEach-Object { Say $_ }
Pop-Location
$open = Join-Path $repo 'proto/secrets/target/release/open-sealed.exe'
Say "open-sealed: $((Get-Item $open).Length) bytes"

Hdr 'Electron 43.8.3'
New-Item -ItemType Directory -Force (Join-Path $work 'el') | Out-Null
Push-Location (Join-Path $work 'el')
npm init -y | Out-Null
npm i --no-save electron@43.8.3 2>&1 | Select-Object -Last 2 | ForEach-Object { Say $_ }
Pop-Location
$electron = Join-Path $work 'el/node_modules/electron/dist/electron.exe'
$seedDir = Join-Path $repo 'proto/secrets/seed'

Hdr 'seed with Electron safeStorage (app name seuoffice)'
$userData = Join-Path $env:APPDATA 'seuoffice'
$env:SEED_LOG = Join-Path $out 'seed.log'
$rc = Run-To $electron "`"$seedDir`"" 150 (Join-Path $out 'seed.stdout') (Join-Path $out 'seed.stderr')
Say "seed exit=$rc"
Get-Content $env:SEED_LOG | ForEach-Object { Say $_ }
Get-ChildItem $userData | ForEach-Object { Say "userData: $($_.Name) $($_.Length)" }
$ls = Get-Content (Join-Path $userData 'Local State') -Raw -Encoding utf8 | ConvertFrom-Json
$ek = $ls.os_crypt.encrypted_key
$raw = [Convert]::FromBase64String($ek)
Say "Local State os_crypt.encrypted_key: base64 length $($ek.Length), raw $($raw.Length) bytes, prefix '$([Text.Encoding]::ASCII.GetString($raw[0..4]))'"
Copy-Item (Join-Path $userData 'proto-secrets.json') (Join-Path $out 'proto-secrets.json')

Hdr 'open-sealed --inspect (blob shape only)'
& $open --user-data $userData --json (Join-Path $userData 'proto-secrets.json') --inspect 2>&1 | ForEach-Object { Say $_ }

Hdr 'W0 control: Electron decrypts its own blobs'
Remove-Item Env:SEED_LOG
$env:SEED_MODE = 'decrypt'
$env:SEED_RESULT = Join-Path $work 'el-dec.json'
$rc = Run-To $electron "`"$seedDir`"" 90 (Join-Path $out 'dec.stdout') (Join-Path $out 'dec.stderr')
Remove-Item Env:SEED_MODE
Say "electron decrypt exit=$rc"
Check 'W0 electron' $env:SEED_RESULT

Hdr 'W1 open-sealed.exe --user-data --json (a different binary)'
$t1o = Join-Path $out 'w1.out'; $t1e = Join-Path $out 'w1.err'
$rc = Run-To $open "--user-data `"$userData`" --json `"$(Join-Path $userData 'proto-secrets.json')`"" 60 $t1o $t1e
Say "W1 exit=$rc"
Say "W1 stderr: $(Get-Content $t1e -Raw)"
Say "W1 stdout (UTF-8 JSON, plaintexts are the fixed test values): $(Get-Content $t1o -Raw -Encoding utf8)"
Check 'W1 open-sealed' $t1o
if ($rc -ne 0) { $fail = 1 }

Hdr 'W2 bare base64 blob (the Drive vault form)'
$sealed = Get-Content (Join-Path $userData 'proto-secrets.json') -Raw -Encoding utf8 | ConvertFrom-Json
$bare = $sealed.drive.Substring('sealed:v1:'.Length)
$w2o = Join-Path $out 'w2.out'
$rc = Run-To $open "--user-data `"$userData`" --blob $bare" 60 $w2o (Join-Path $out 'w2.err')
Say "W2 exit=$rc stdout: $(Get-Content $w2o -Raw -Encoding utf8)"
$w2 = Get-Content $w2o -Raw -Encoding utf8 | ConvertFrom-Json
$exp = Get-Content (Join-Path $repo 'proto/secrets/seed/expected.json') -Raw -Encoding utf8 | ConvertFrom-Json
if ($w2.blob -cne $exp.drive) { Say 'W2 DIFFERENT'; $fail = 1 } else { Say 'W2 EQUAL to seeded Drive value' }

Hdr 'W3 failure path: a damaged blob must exit non-zero with a code'
$rc = Run-To $open "--user-data `"$userData`" --blob $($bare.Substring(0, $bare.Length - 8))AAAAAAAA" 60 (Join-Path $out 'w3.out') (Join-Path $out 'w3.err')
Say "W3 exit=$rc stderr: $(Get-Content (Join-Path $out 'w3.err') -Raw)"
if ($rc -eq 0) { $fail = 1 }

Say "done, fail=$fail"
exit $fail
