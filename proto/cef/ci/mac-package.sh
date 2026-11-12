#!/usr/bin/env bash
# Packs the built SeuOffice.app the way proto/README.md asks and runs the
# checks apps/shell/src/main/mac-update.ts (stageMacUpdate) makes on an update.
#   mac-package.sh <SeuOffice.app> <outdir>
set -uo pipefail
app=$1
out=$2
version=0.13.0
zip="$out/SeuOffice-$version-arm64-mac.zip"
mkdir -p "$out"
status=0

echo '--- Info.plist identity'
plist="$app/Contents/Info.plist"
for key in CFBundleIdentifier CFBundleShortVersionString CFBundleName CFBundleExecutable; do
  printf '%s = ' "$key"
  /usr/libexec/PlistBuddy -c "Print :$key" "$plist"
done
echo '--- CFBundleDocumentTypes'
/usr/libexec/PlistBuddy -c 'Print :CFBundleDocumentTypes' "$plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleDocumentTypes' "$plist" | grep -q docx || { echo 'FAIL: no docx document type'; status=1; }

echo '--- bundle layout'
ls "$app/Contents/Frameworks" || true
du -sh "$app"

echo '--- codesign (the built bundle)'
codesign -dv --verbose=2 "$app" 2>&1 | head -20
if codesign --verify --deep --strict --verbose=2 "$app"; then
  echo 'codesign verify OK (built bundle)'
else
  echo 'FAIL: codesign --verify --deep --strict on the built bundle'
  status=1
fi

rm -f "$zip"
ditto -c -k --keepParent "$app" "$zip"
ls -la "$zip"

echo '--- updater checks on the zip (stageMacUpdate)'
stage=$(mktemp -d)/staging
mkdir -p "$stage"
ditto -x -k "$zip" "$stage"
apps=$(find "$stage" -maxdepth 1 -name '*.app' | wc -l | tr -d ' ')
[ "$apps" = 1 ] || { echo "FAIL: the zip holds $apps apps"; status=1; }
staged=$(find "$stage" -maxdepth 1 -name '*.app' | head -1)
v=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$staged/Contents/Info.plist")
id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$staged/Contents/Info.plist")
[ "$v" = "$version" ] || { echo "FAIL: version $v"; status=1; }
[ "$id" = com.seuput.seuoffice ] || { echo "FAIL: identifier $id"; status=1; }
if codesign --verify --deep --strict "$staged"; then
  echo 'codesign verify OK (unpacked zip)'
else
  echo 'FAIL: codesign --verify --deep --strict on the unpacked zip'
  status=1
fi
echo "$staged" > "$out/staged-app-path.txt"
echo "exe: ${staged#$stage/}/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$staged/Contents/Info.plist")"
exit $status
