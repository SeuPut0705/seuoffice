#!/usr/bin/env bash
# The migration acceptance test of decision 0029 on a macOS runner: the path
# of win-desktop.ps1 without the faults. Install the Electron release FROM in
# /Applications, open a mock document, seed data, point the updater at a
# local feed offering TO_ZIP, update through the app's dialog (mac-update.ts
# stages and swaps the bundle), and check the updated app shows the data.
#
#   mac-runner.sh <from tag> <to zip> <to version> <out dir>
#
# The bundle is signed again ad hoc after app-update.yml is rewritten; the
# AI key is seeded after that, so the keychain item belongs to the signed
# app (decision 0029 (b): a new signature asks once, as every update does).
set -euo pipefail
from=$1 to_zip=$2 to_version=$3 out=$4
here=$(cd "$(dirname "$0")" && pwd)
app=/Applications/SeuOffice.app
port=9229
mkdir -p "$out/from"
result() { printf '%s\n' "$1" >>"$out/result.txt"; echo "== $1"; }
probe() { node "$here/probe.mjs" "$@" --port "$port"; }
start_app() { "$app/Contents/MacOS/SeuOffice" --remote-debugging-port=$port "$@" >>"$out/app.log" 2>&1 & }
stop_app() {
  osascript -e 'tell application id "com.seuput.seuoffice" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 20); do pgrep -f "$app/Contents/MacOS/SeuOffice" >/dev/null || return 0; sleep 1; done
  pkill -9 -f "$app/Contents/MacOS/SeuOffice" || true
}
version() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist"; }
trap 'stop_app; kill ${feed:-0} 2>/dev/null || true' EXIT

gh release download "$from" --repo SeuPut0705/seuoffice --dir "$out/from" --pattern 'SeuOffice-*-arm64-mac.zip' --clobber
zip=$(ls "$out"/from/SeuOffice-*-arm64-mac.zip | grep -v stable | head -1)
rm -rf "$app"
ditto -x -k "$zip" /Applications
from_version=$(version)
result "installed $from_version"

mkdir -p "$out/feed"
node "$here/feed.mjs" make --file "$to_zip" --version "$to_version" --out "$out/feed" >/dev/null
node "$here/feed.mjs" serve --dir "$out/feed" --port 8765 >"$out/feed.log" 2>&1 &
feed=$!
node "$here/feed.mjs" point --resources "$app/Contents/Resources" --url http://127.0.0.1:8765/ >/dev/null
codesign --force --deep -s - "$app"

node "$here/probe.mjs" make-docx "$out/migration-test.docx"
start_app "$out/migration-test.docx"
sleep 10
probe seed --out "$out/seed.json"
stop_app
result seeded

start_app
probe update --version "$to_version"
for _ in $(seq 180); do [ "$(version)" = "$to_version" ] && break; sleep 1; done
# the swap relaunches the app after the new bundle is in place: wait for it,
# or a later start hands over to it (single instance) and quits
for _ in $(seq 60); do pgrep -f "$app/Contents/MacOS/SeuOffice" >/dev/null && break; sleep 1; done
sleep 10
stop_app
[ "$(version)" = "$to_version" ] || { result "still $(version) after the update"; exit 1; }
result "updated to $to_version"

start_app
sleep 10
probe check --seed "$out/seed.json" --version "$to_version"
result passed
