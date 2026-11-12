#!/usr/bin/env bash
# Proof (a)+(c) on macOS, runner only: the shipped Electron app v0.12.37 is
# installed in /Applications and has run once (real-app.py), its userData is
# in place, and the docx default handler is set to com.seuput.seuoffice. The
# candidate's update zip then goes through the SHIPPED update code itself:
# stageMacUpdate (ditto, version and bundle id checks, codesign --verify
# --deep --strict) and startMacSwap (MAC_SWAP_SCRIPT), bundled from
# apps/shell/src/main/mac-update.ts. The swap waits for a stand-in pid (the
# old app has already quit), moves the bundles and opens the new app with
# --updated. Then: the new app started, sees the same userData, the files
# there are unchanged, and LaunchServices still sends docx to the bundle id.
#   update-proof-mac.sh <candidate zip> <shell> <out dir>
set -uo pipefail
zip=$1 shell=$2 out=$3
app=/Applications/SeuOffice.app
ud="$HOME/Library/Application Support/seuoffice"
mkdir -p "$out"
py=${PYTHON:-python3}
hashes() { (cd "$ud" && find . -type f ! -name proto-shell-started.json ! -path './Crashpad/*' -print0 | sort -z | xargs -0 shasum -a 256); }

"$py" - <<'EOF'
from CoreServices import LSSetDefaultRoleHandlerForContentType, kLSRolesAll
print('set docx handler:', LSSetDefaultRoleHandlerForContentType('org.openxmlformats.wordprocessingml.document', kLSRolesAll, 'com.seuput.seuoffice'))
EOF
rm -f "$ud/proto-shell-started.json"
hashes > "$out/userdata-before.txt"
plutil -extract CFBundleDocumentTypes json -o "$out/doctypes-before.json" "$app/Contents/Info.plist"

npx -y esbuild@0.25.11 apps/shell/src/main/mac-update.ts --bundle --platform=node --format=cjs \
  --outfile="$RUNNER_TEMP/mac-update.cjs" --log-level=warning
sleep 5 &
standin=$!
node - "$zip" "$app" "$standin" "$out/swap.log" <<'EOF' | tee "$out/stage.json"
const [zip, bundle, pid, log] = process.argv.slice(2)
const m = require(process.env.RUNNER_TEMP + '/mac-update.cjs')
;(async () => {
  try {
    const staged = await m.stageMacUpdate({ zip, bundle, version: '0.13.0' })
    const started = m.startMacSwap({ pid: Number(pid), bundle, staged, logFile: log })
    console.log(JSON.stringify({ staged, started }))
  } catch (error) {
    console.log(JSON.stringify({ stageError: String(error) }))
    process.exitCode = 1
  }
})()
EOF
for _ in $(seq 1 90); do
  [ -f "$ud/proto-shell-started.json" ] && break
  sleep 1
done
sleep 3
started=$(cat "$ud/proto-shell-started.json" 2>/dev/null || echo null)
pkill -f "$app/Contents/MacOS/" || true
sleep 2
hashes > "$out/userdata-after.txt"
plutil -extract CFBundleDocumentTypes json -o "$out/doctypes-after.json" "$app/Contents/Info.plist"
handler=$("$py" - <<'EOF'
import json
from CoreServices import LSCopyDefaultRoleHandlerForContentType, LSCopyApplicationURLsForBundleIdentifier, kLSRolesAll
h = LSCopyDefaultRoleHandlerForContentType('org.openxmlformats.wordprocessingml.document', kLSRolesAll)
urls, err = LSCopyApplicationURLsForBundleIdentifier(h, None)
print(json.dumps({'handler': h, 'apps': [str(u.path()) for u in (urls or [])]}))
EOF
)
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")
bundleid=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")
same=false
cmp -s "$out/userdata-before.txt" "$out/userdata-after.txt" && same=true
cat > "$out/update-proof.json" <<EOF
{
  "shell": "$shell",
  "installedVersion": "$version",
  "bundleId": "$bundleid",
  "stage": $(cat "$out/stage.json" 2>/dev/null || echo null),
  "newAppStarted": $started,
  "userDataFiles": $(wc -l < "$out/userdata-before.txt"),
  "userDataUnchanged": $same,
  "docxHandler": $handler,
  "swapLog": $(python3 -c 'import json,sys; print(json.dumps(open(sys.argv[1]).read() if __import__("os").path.exists(sys.argv[1]) else None))' "$out/swap.log")
}
EOF
cat "$out/update-proof.json"
diff "$out/userdata-before.txt" "$out/userdata-after.txt" | head -20
