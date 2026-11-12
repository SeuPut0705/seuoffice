#!/bin/bash
# macOS proof: Electron 43.8.3 seals, a different binary (open-sealed) opens, and the
# keychain ACL facts are recorded. Every step records its result and carries on, so one
# refusal does not hide the next measurement. Output: $OUT/findings.txt plus raw files.
set -u
REPO=$PWD
WORK=${RUNNER_TEMP:-/tmp}/secrets-proof
OUT=$WORK/out
SVC='seuoffice Safe Storage'
mkdir -p "$OUT" "$WORK"
F=$OUT/findings.txt
: > "$F"
say() { echo "$*" | tee -a "$F"; }
hdr() { say ""; say "=== $* ==="; }

# run_to <seconds> <cmd...>: run with a deadline (macOS has no timeout(1)); 124 = killed.
run_to() {
  local secs=$1; shift
  "$@" & local pid=$!
  ( sleep "$secs"; kill -9 "$pid" 2>/dev/null && touch "$WORK/.timedout.$pid" ) & local w=$!
  wait "$pid"; local rc=$?
  kill "$w" 2>/dev/null; wait "$w" 2>/dev/null
  if [ -e "$WORK/.timedout.$pid" ]; then rm -f "$WORK/.timedout.$pid"; return 124; fi
  return $rc
}

# watch_prompt <label>: is a keychain access dialog on screen right now
watch_prompt() {
  say "[$1] SecurityAgent processes: $(pgrep -lf SecurityAgent | tr '\n' ';')"
  screencapture -x "$OUT/$1.png" 2>/dev/null && say "[$1] screenshot saved ($1.png)" || say "[$1] screenshot failed"
  osascript -e 'tell application "System Events" to get name of every process whose name contains "SecurityAgent" or name contains "UserNotificationCenter"' 2>&1 | head -3 | sed "s/^/[$1] osascript: /" | tee -a "$F"
}

cdhash() { codesign -dvvv "$1" 2>&1 | sed -n 's/^CDHash=/cdhash=/p;s/^Identifier=/id=/p;s/^Signature=/sig=/p;s/^TeamIdentifier=/team=/p' | tr '\n' ' '; }

item_block() { # the dump-keychain record of the item whose svce is $1, in $2 (keychain)
  security dump-keychain -a "$2" 2>&1 | python3 -c '
import sys,re
text=sys.stdin.read()
blocks=re.split(r"(?m)^(?=keychain: )",text)
want=sys.argv[1]
for b in blocks:
    if "\"svce\"<blob>=\""+want+"\"" in b: print(b.rstrip())
' "$1"
}

check() { # check <label> <json-file>: do the plaintexts equal the seeded ones
  python3 - "$1" "$2" "$REPO/proto/secrets/seed/expected.json" <<'PY' | tee -a "$F"
import json,sys
label,got,exp=sys.argv[1:4]
try: g=json.load(open(got,encoding='utf-8'))
except Exception as e: print(f"[{label}] PLAINTEXT CHECK: no JSON ({e})"); sys.exit(1)
e=json.load(open(exp,encoding='utf-8'))
ok=all(g.get(k)==v for k,v in e.items())
print(f"[{label}] PLAINTEXT CHECK: {'EQUAL to seeded values' if ok else 'DIFFERENT'} (keys {sorted(g)})")
sys.exit(0 if ok else 1)
PY
}

hdr "environment"
sw_vers | tee -a "$F"; uname -m | tee -a "$F"
whoami | tee -a "$F"
rustc --version | tee -a "$F"
echo "console user: $(stat -f%Su /dev/console)" | tee -a "$F"

hdr "temp keychain (known password) as default, like a login keychain"
KC="$WORK/proof.keychain-db"; KCPW='proof-keychain-pw'
security create-keychain -p "$KCPW" "$KC" && security set-keychain-settings "$KC" && security unlock-keychain -p "$KCPW" "$KC"
ORIG_LIST=$(security list-keychains -d user | tr -d '"' | xargs)
security list-keychains -d user -s "$KC" $ORIG_LIST
security default-keychain -d user -s "$KC"
security list-keychains -d user | tee -a "$F"
security default-keychain | tee -a "$F"
say "item before seeding (must be absent):"
security find-generic-password -s "$SVC" 2>&1 | head -2 | tee -a "$F"

hdr "build the Rust crate"
( cd proto/secrets && cargo test --release 2>&1 | tail -15 && cargo build --release 2>&1 | tail -3 ) | tee -a "$F"
OPEN=$REPO/proto/secrets/target/release/open-sealed
ls -l "$OPEN" | tee -a "$F"
say "open-sealed $(cdhash "$OPEN")"

hdr "Electron 43.8.3"
mkdir -p "$WORK/el" && ( cd "$WORK/el" && npm init -y >/dev/null && npm i --no-save electron@43.8.3 2>&1 | tail -2 )
ORIG_APP=$WORK/el/node_modules/electron/dist/Electron.app
say "downloaded Electron: $(cdhash "$ORIG_APP")"
codesign --verify --deep --strict "$ORIG_APP" 2>&1 | tee -a "$F"
mkdir -p "$WORK/A"; ditto "$ORIG_APP" "$WORK/A/Electron.app"
codesign -f -s - --deep "$WORK/A/Electron.app" 2>&1 | tail -1
EL_A=$WORK/A/Electron.app/Contents/MacOS/Electron
say "app A (the installed build, ad hoc signed like decision 0031): $(cdhash "$WORK/A/Electron.app")"
codesign -d -r- "$WORK/A/Electron.app" 2>&1 | grep -E 'designated' | tee -a "$F"

hdr "seed with app A (Electron safeStorage, app name seuoffice)"
export SEED_DIR=$REPO/proto/secrets/seed
run_to 150 "$EL_A" "$SEED_DIR" 2>&1 | tee "$WORK/seed.log" | tee -a "$F"
USERDATA="$HOME/Library/Application Support/seuoffice"
ls -la "$USERDATA" | tee -a "$F"
cp "$USERDATA/proto-secrets.json" "$OUT/proto-secrets.json" 2>/dev/null

hdr "keychain item attributes and ACL (no secret printed)"
security find-generic-password -s "$SVC" 2>&1 | tee -a "$F"
item_block "$SVC" "$KC" | tee -a "$F"
security dump-keychain -a "$KC" > "$OUT/dump-keychain-a.txt" 2>&1

hdr "open-sealed --inspect (blob shape only)"
"$OPEN" --user-data "$USERDATA" --json "$USERDATA/proto-secrets.json" --inspect 2>&1 | tee -a "$F"

hdr "T0 control: app A itself decrypts (trusted by the item's ACL)"
SEED_MODE=decrypt SEED_RESULT="$WORK/a-dec.json" run_to 60 "$EL_A" "$SEED_DIR" 2>&1 | tail -2 | tee -a "$F"
say "exit=$?"; check "T0 app A" "$WORK/a-dec.json"

hdr "T1 open-sealed, user interaction disabled (the foreign binary)"
run_to 60 "$OPEN" --user-data "$USERDATA" --json "$USERDATA/proto-secrets.json" > "$WORK/t1.out" 2> "$WORK/t1.err"; T1=$?
say "T1 exit=$T1"; say "T1 stdout bytes: $(wc -c < "$WORK/t1.out")"; say "T1 stderr: $(cat "$WORK/t1.err")"
check "T1 open-sealed" "$WORK/t1.out"
cp "$WORK/t1.err" "$OUT/t1.err"

hdr "T1b the same with the item probe (macOS key read only)"
run_to 60 "$OPEN" --probe --service "$SVC" --account seuoffice > "$WORK/t1b.out" 2> "$WORK/t1b.err"
say "T1b exit=$? stdout=$(cat "$WORK/t1b.out") stderr=$(cat "$WORK/t1b.err")"

hdr "T2 open-sealed with the prompt allowed (what a user would see)"
( run_to 45 "$OPEN" --allow-interaction --user-data "$USERDATA" --json "$USERDATA/proto-secrets.json" > "$WORK/t2.out" 2> "$WORK/t2.err"; echo "T2 exit=$? stdout=$(cat "$WORK/t2.out") stderr=$(cat "$WORK/t2.err")" > "$WORK/t2.res" ) &
T2PID=$!
sleep 15; watch_prompt t2-prompt
wait $T2PID; cat "$WORK/t2.res" | tee -a "$F"
pkill -f SecurityAgent 2>/dev/null; sleep 2

hdr "T3 an updated ad hoc build of Electron (cdhash changes) asks for the same item"
cp -R "$WORK/A/Electron.app" "$WORK/A2.app"
mkdir -p "$WORK/A2" && rm -rf "$WORK/A2/Electron.app" && mv "$WORK/A2.app" "$WORK/A2/Electron.app"
codesign -f -s - --deep "$WORK/A2/Electron.app" 2>&1 | tail -1
say "T3a rebuilt, same bits: $(cdhash "$WORK/A2/Electron.app")"
SEED_MODE=decrypt SEED_RESULT="$WORK/a2-dec.json" run_to 60 "$WORK/A2/Electron.app/Contents/MacOS/Electron" "$SEED_DIR" 2>&1 | tail -1 | tee -a "$F"
say "T3a exit=${PIPESTATUS[0]}"; check "T3a same-cdhash copy" "$WORK/a2-dec.json"

mkdir -p "$WORK/B"; ditto "$WORK/A/Electron.app" "$WORK/B/Electron.app"
/usr/libexec/PlistBuddy -c 'Set :CFBundleVersion 43.8.3-build2' -c 'Set :CFBundleShortVersionString 43.8.3' "$WORK/B/Electron.app/Contents/Info.plist"
codesign -f -s - --deep "$WORK/B/Electron.app" 2>&1 | tail -1
say "T3b updated build (Info.plist changed, re-signed ad hoc): $(cdhash "$WORK/B/Electron.app")"
( SEED_MODE=decrypt SEED_RESULT="$WORK/b-dec.json" run_to 60 "$WORK/B/Electron.app/Contents/MacOS/Electron" "$SEED_DIR" > "$WORK/b.log" 2>&1; echo "T3b exit=$?" > "$WORK/b.res" ) &
BPID=$!
sleep 20; watch_prompt t3b-prompt
wait $BPID; cat "$WORK/b.res" | tee -a "$F"; tail -2 "$WORK/b.log" | tee -a "$F"
check "T3b updated Electron" "$WORK/b-dec.json"
pkill -f SecurityAgent 2>/dev/null; sleep 2

hdr "ACL after the tests (did any run change it)"
item_block "$SVC" "$KC" | tee -a "$F"

# ---- routes ----
hdr "R1 a key item that names the Rust binary in its ACL (-T), made by a process that is not the Rust binary"
RSVC='seuoffice-rust test key'
security add-generic-password -a seuoffice-rust -s "$RSVC" -w 'rust-side-key-material' -T "$OPEN" "$KC" 2>&1 | tee -a "$F"
run_to 30 "$OPEN" --probe --service "$RSVC" --account seuoffice-rust 2>&1 | tee -a "$F"; say "R1 exit=${PIPESTATUS[0]}"
mkdir -p "$WORK/open2" && cp "$OPEN" "$WORK/open2/open-sealed" && codesign -f -s - -i com.seuput.seuoffice.rebuilt "$WORK/open2/open-sealed" 2>&1 | tail -1
say "R1 rebuilt Rust binary (new identifier, so new cdhash): $(cdhash "$WORK/open2/open-sealed")"
run_to 30 "$WORK/open2/open-sealed" --probe --service "$RSVC" --account seuoffice-rust 2>&1 | tee -a "$F"; say "R1 rebuilt exit=${PIPESTATUS[0]}"
mkdir -p "$WORK/open3" && cp "$OPEN" "$WORK/open3/moved-open-sealed"
say "R1 same binary at another path: $(cdhash "$WORK/open3/moved-open-sealed")"
run_to 30 "$WORK/open3/moved-open-sealed" --probe --service "$RSVC" --account seuoffice-rust 2>&1 | tee -a "$F"; say "R1 moved exit=${PIPESTATUS[0]}"
item_block "$RSVC" "$KC" | tee -a "$F"

hdr "R2 a key item open to every application (-A)"
security add-generic-password -a seuoffice-rust -s 'seuoffice-rust any-app key' -w 'rust-side-key-material' -A "$KC" 2>&1 | tee -a "$F"
run_to 30 "$OPEN" --probe --service 'seuoffice-rust any-app key' --account seuoffice-rust 2>&1 | tee -a "$F"; say "R2 exit=${PIPESTATUS[0]}"

hdr "R3 partition list of the Electron item widened with the keychain password (security set-generic-password-partition-list)"
OPEN_HASH=$(codesign -dvvv "$OPEN" 2>&1 | sed -n 's/^CDHash=//p')
security set-generic-password-partition-list -S "apple-tool:,apple:,cdhash:$OPEN_HASH" -k "$KCPW" -s "$SVC" -a seuoffice "$KC" 2>&1 | tail -2 | tee -a "$F"
item_block "$SVC" "$KC" | tee -a "$F"
run_to 30 "$OPEN" --user-data "$USERDATA" --json "$USERDATA/proto-secrets.json" > "$WORK/r3.out" 2> "$WORK/r3.err"
say "R3 exit=$? stderr=$(cat "$WORK/r3.err")"; check "R3 after partition list" "$WORK/r3.out"

hdr "summary"
cp "$WORK"/*.log "$WORK"/*.res "$WORK"/*.err "$WORK"/*.out "$OUT"/ 2>/dev/null
say "done"
exit 0
