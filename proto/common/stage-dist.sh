#!/usr/bin/env bash
# Builds the frontend folder every prototype shell serves: the Word editor of
# the v0.12.37 web bundle (dist/docs, dist/template-fonts) and the measurement
# host page as the start page. Needs gh (GH_TOKEN on a runner).
#   proto/common/stage-dist.sh <out-dir>
set -euo pipefail
out=$1
here=$(cd "$(dirname "$0")" && pwd)
tag=${WEB_BUNDLE_TAG:-v0.12.37}
work=$(mktemp -d)
gh release download "$tag" -R SeuPut0705/seuoffice -p "seuoffice-web-${tag#v}.tgz" -D "$work"
tar xzf "$work"/seuoffice-web-*.tgz -C "$work"
rm -rf "$out"
mkdir -p "$out"
cp -R "$work/package/dist/docs" "$work/package/dist/template-fonts" "$out/"
cp "$here/host/host.html" "$here/host/host.js" "$out/"
rm -rf "$work"
echo "staged $(du -sh "$out" | cut -f1) in $out"
