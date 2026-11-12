#!/bin/bash
# macOS proof: Electron 43.8.3 seals, a different binary (open-sealed) opens, and the
# keychain ACL facts are recorded. Every step records its result and carries on, so one
# refusal does not hide the next measurement. Output: $OUT/findings.txt plus raw files.
set -u
REPO=$PWD
WORK=${RUNNER_TEMP:-/tmp}/secrets-proof
OUT=$WORK/out
SVC='seuoffice Safe Storage'
ACCT='seuoffice Key'
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
mkdir -p "$WORK/el" && ( cd "$WORK/el" && npm init -y >/dev/null && npm i --no-save electron@43.8.3 2>&1 | tail -2 && node node_modules/electron/install.js 2>&1 | tail -3 )
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
run_to 60 "$OPEN" --probe --service "$SVC" --account "$ACCT" > "$WORK/t1b.out" 2> "$WORK/t1b.err"
say "T1b exit=$? stdout=$(cat "$WORK/t1b.out") stderr=$(cat "$WORK/t1b.err")"

# answer_prompt <label> <button> <seconds to wait first>: press a button in the keychain prompt
answer_prompt() {
  sleep "$3"; watch_prompt "$1"
  osascript "$REPO/proto/secrets/ci/click-prompt.applescript" "$KCPW" "$2" 2>&1 | tee "$OUT/$1-ui.txt" | sed "s/^/[$1] ui: /" | tee -a "$F"
}

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
EL_B=$WORK/B/Electron.app/Contents/MacOS/Electron
( SEED_MODE=decrypt SEED_RESULT="$WORK/b-dec.json" run_to 40 "$EL_B" "$SEED_DIR" > "$WORK/b.log" 2>&1; echo "T3b exit=$?" > "$WORK/b.res" ) &
BPID=$!
sleep 20; watch_prompt t3b-prompt
wait $BPID; cat "$WORK/b.res" | tee -a "$F"; tail -2 "$WORK/b.log" | tee -a "$F"
check "T3b updated Electron, nobody answers the prompt" "$WORK/b-dec.json"
pkill -f SecurityAgent 2>/dev/null; sleep 2

hdr "T3c the same updated Electron, the user types the password and presses Always Allow"
rm -f "$WORK/b-dec.json"
( SEED_MODE=decrypt SEED_RESULT="$WORK/b-dec.json" run_to 60 "$EL_B" "$SEED_DIR" > "$WORK/b2.log" 2>&1; echo "T3c exit=$?" > "$WORK/b2.res" ) &
BPID=$!
answer_prompt t3c-click "Always Allow" 15
wait $BPID; cat "$WORK/b2.res" | tee -a "$F"; tail -1 "$WORK/b2.log" | tee -a "$F"
check "T3c updated Electron after Always Allow" "$WORK/b-dec.json"
say "T3c again, nothing to click:"
SEED_MODE=decrypt SEED_RESULT="$WORK/b-dec2.json" run_to 40 "$EL_B" "$SEED_DIR" > /dev/null 2>&1; say "exit=$?"; check "T3c second run" "$WORK/b-dec2.json"
pkill -f SecurityAgent 2>/dev/null; sleep 1
say "the old build A (not updated) still opens it:"
rm -f "$WORK/a-dec2.json"; SEED_MODE=decrypt SEED_RESULT="$WORK/a-dec2.json" run_to 40 "$EL_A" "$SEED_DIR" > /dev/null 2>&1; say "exit=$?"; check "T3c old build A" "$WORK/a-dec2.json"

hdr "T2 open-sealed with the prompt allowed, the user presses Always Allow once"
( run_to 60 "$OPEN" --allow-interaction --user-data "$USERDATA" --json "$USERDATA/proto-secrets.json" > "$WORK/t2.out" 2> "$WORK/t2.err"; echo "T2 exit=$? stdout=$(cat "$WORK/t2.out") stderr=$(cat "$WORK/t2.err")" > "$WORK/t2.res" ) &
T2PID=$!
answer_prompt t2-click "Always Allow" 12
wait $T2PID; cat "$WORK/t2.res" | tee -a "$F"
pkill -f SecurityAgent 2>/dev/null; sleep 1
check "T2 open-sealed after Always Allow" "$WORK/t2.out"
hdr "T4 open-sealed again, interaction disabled: no more prompt after the one click"
run_to 60 "$OPEN" --user-data "$USERDATA" --json "$USERDATA/proto-secrets.json" > "$WORK/t4.out" 2> "$WORK/t4.err"
say "T4 exit=$? stderr=$(cat "$WORK/t4.err")"; check "T4 open-sealed non-interactive" "$WORK/t4.out"
say "T4b a rebuilt Rust binary (new cdhash) non-interactive:"
mkdir -p "$WORK/open4" && cp "$OPEN" "$WORK/open4/open-sealed" && codesign -f -s - -i com.seuput.seuoffice.rebuilt2 "$WORK/open4/open-sealed" 2>&1 | tail -1
run_to 60 "$WORK/open4/open-sealed" --user-data "$USERDATA" --json "$USERDATA/proto-secrets.json" > "$WORK/t4b.out" 2> "$WORK/t4b.err"
say "T4b exit=$? stderr=$(cat "$WORK/t4b.err")"

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
security set-generic-password-partition-list -S "apple-tool:,apple:,cdhash:$OPEN_HASH" -k "$KCPW" -s "$SVC" -a "$ACCT" "$KC" 2>&1 | tail -2 | tee -a "$F"
item_block "$SVC" "$KC" | tee -a "$F"
run_to 30 "$OPEN" --user-data "$USERDATA" --json "$USERDATA/proto-secrets.json" > "$WORK/r3.out" 2> "$WORK/r3.err"
say "R3 exit=$? stderr=$(cat "$WORK/r3.err")"; check "R3 after partition list" "$WORK/r3.out"

hdr "R4 a stable signing identity: Electron sealed by a self-signed build, then updated and signed with the same certificate"
S=$WORK/self; mkdir -p "$S"
cat > "$S/ext.cnf" <<'CNF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = seuoffice proto signer
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -keyout "$S/k.pem" -out "$S/c.pem" -days 2 -config "$S/ext.cnf" 2>&1 | tail -1
/usr/bin/openssl pkcs12 -export -inkey "$S/k.pem" -in "$S/c.pem" -out "$S/id.p12" -passout pass:p12pw 2>&1 | tail -1
security import "$S/id.p12" -k "$KC" -P p12pw -T /usr/bin/codesign 2>&1 | tee -a "$F"
security set-key-partition-list -S apple-tool:,apple:,codesign: -k "$KCPW" "$KC" >/dev/null 2>&1
sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$S/c.pem" 2>&1 | tee -a "$F"
security find-identity -p codesigning "$KC" 2>&1 | tee -a "$F"
SIGN_ID=$(/usr/bin/openssl x509 -in "$S/c.pem" -noout -fingerprint -sha1 | sed 's/.*=//;s/://g')
say "signing identity sha1 $SIGN_ID"

# the item moves to a second keychain so the new seed does not find the A-owned one
KC2="$WORK/proof2.keychain-db"
security create-keychain -p "$KCPW" "$KC2" && security set-keychain-settings "$KC2" && security unlock-keychain -p "$KCPW" "$KC2"
security default-keychain -d user -s "$KC2"
security list-keychains -d user -s "$KC2" $ORIG_LIST

mkdir -p "$WORK/S1"; ditto "$ORIG_APP" "$WORK/S1/Electron.app"
codesign -f -s "$SIGN_ID" --deep "$WORK/S1/Electron.app" 2>&1 | tail -2 | tee -a "$F"
say "S1 (installed build, self-signed): $(cdhash "$WORK/S1/Electron.app")"
codesign -d -r- "$WORK/S1/Electron.app" 2>&1 | grep designated | tee -a "$F"
export BENCH_USER_DATA="$WORK/ud4"
run_to 150 "$WORK/S1/Electron.app/Contents/MacOS/Electron" "$SEED_DIR" 2>&1 | tail -3 | tee -a "$F"
item_block "$SVC" "$KC2" | sed -n '/access:/,$p' | tee -a "$F"

mkdir -p "$WORK/S2"; ditto "$WORK/S1/Electron.app" "$WORK/S2/Electron.app"
/usr/libexec/PlistBuddy -c 'Set :CFBundleVersion 43.8.3-build2' "$WORK/S2/Electron.app/Contents/Info.plist"
codesign -f -s "$SIGN_ID" --deep "$WORK/S2/Electron.app" 2>&1 | tail -2 | tee -a "$F"
say "S2 (updated build, same certificate): $(cdhash "$WORK/S2/Electron.app")"
( SEED_MODE=decrypt SEED_RESULT="$WORK/s2-dec.json" run_to 40 "$WORK/S2/Electron.app/Contents/MacOS/Electron" "$SEED_DIR" > "$WORK/s2.log" 2>&1; echo "R4 updated exit=$?" > "$WORK/s2.res" ) &
SPID=$!
sleep 15; watch_prompt r4-prompt
wait $SPID; cat "$WORK/s2.res" | tee -a "$F"; tail -1 "$WORK/s2.log" | tee -a "$F"
check "R4 updated Electron, same certificate" "$WORK/s2-dec.json"
pkill -f SecurityAgent 2>/dev/null
unset BENCH_USER_DATA
sudo security remove-trusted-cert -d "$S/c.pem" 2>&1 | tail -1

hdr "summary"
cp "$WORK"/*.log "$WORK"/*.res "$WORK"/*.err "$WORK"/*.out "$OUT"/ 2>/dev/null
say "done"
exit 0
