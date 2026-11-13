#!/usr/bin/env bash
# Packs what `npm run build:all` and the sheets fixture generator wrote, so the
# e2e shards of ci.yml unpack one build instead of each building the apps again.
#
#   tools/pack-build-output.sh <archive.tar.zst>    write the archive
#   tools/pack-build-output.sh --list               print what would go in it
#
# The list is not kept by hand: it is every path of the tree git does not
# track (ignored or not), less what a shard gets for itself (node_modules, from
# `npm ci`) and what no test reads (cargo target folders, the draw.io
# download). Of the cargo target folders two files are kept: the xlsx sidecar
# the shell starts, and the engine wasm of crates/office-wasm in a tree that
# has it. A new build output is therefore packed without a change here.
set -euo pipefail

usage='usage: tools/pack-build-output.sh <archive.tar.zst> | --list'
target=${1:?$usage}
[ $# -eq 1 ] || { echo "$usage" >&2; exit 2; }

cd "$(git rev-parse --show-toplevel)"

sidecar=apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar
engine_wasm=crates/target/wasm32-wasip1/release/office_wasm.wasm
shell_main=apps/shell/out/main/index.js

# an archive without these is a build that did not happen
for need in "$sidecar" "$shell_main"; do
  [ -e "$need" ] || { echo "pack-build-output: $need is missing; run npm run build:all first" >&2; exit 1; }
done

list=$(mktemp)
trap 'rm -f "$list"' EXIT

# --ignored=matching names a folder that an ignore pattern matches once and
# does not look inside it, which is also what keeps packages/cli/dist/node_modules
# (the CLI's own copy of its dependencies) while the installed node_modules
# folders drop out
git status --porcelain -z --ignored=matching --untracked-files=normal |
  perl -0lne '
    next unless s/^(?:!!|\?\?) //;
    next if m{(?:^|/)(?:node_modules|target)/$} || $_ eq "vendor/drawio/.cache/";
    print' > "$list"
printf '%s\0' "$sidecar" >> "$list"
if [ -e "$engine_wasm" ]; then printf '%s\0' "$engine_wasm" >> "$list"; fi

if [ "$target" = --list ]; then
  tr '\0' '\n' < "$list"
  exit 0
fi

tar --use-compress-program 'zstd -T0' --null --files-from "$list" -cf "$target"
