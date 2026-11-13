#!/bin/bash
# cargo check / clippy / test of crates/shell on a workstation, without the 1 GB CEF download.
#
#   crates/shell/ci/check-local.sh check
#   crates/shell/ci/check-local.sh clippy --no-deps --all-targets -- -D warnings
#   crates/shell/ci/check-local.sh test
#
# The cef crate has a `dox` feature (what docs.rs builds with) that skips the
# download and the link line. This makes a shadow package in $SHELL_CHECK_DIR
# (default: a temp folder) that shares src/, build.rs and frontend/ with
# crates/shell through symlinks, takes its manifest with `cef/dox` added, and
# runs the cargo command there. `test` links with `-undefined dynamic_lookup`
# (macOS) so the test binary can be built; no test calls into CEF. The preloads
# (`node crates/shell/bridge/preloads.mjs`) must be built first: src/preload.rs
# includes them.
set -euo pipefail

shell_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="${SHELL_CHECK_DIR:-${TMPDIR:-/tmp}/seuoffice-shell-check}"
target="${CARGO_TARGET_DIR:-$work/target}"

mkdir -p "$work"
for entry in src build.rs frontend out; do
  ln -sfn "$shell_dir/$entry" "$work/$entry"
done

python3 - "$shell_dir" "$work" <<'PY'
import json, os, sys
shell, work = sys.argv[1:3]
manifest = open(os.path.join(shell, "Cargo.toml")).read()
# path dependencies and the regress patch point out of the folder
manifest = manifest.replace('path = "../', 'path = "' + os.path.normpath(os.path.join(shell, "..")) + "/")
manifest = manifest.replace('cef = "=154.5.0"', 'cef = { version = "=154.5.0", features = ["dox"] }', 1)
open(os.path.join(work, "Cargo.toml"), "w").write(manifest)
conf = json.load(open(os.path.join(shell, "tauri.conf.json")))
conf["bundle"]["icon"] = [os.path.normpath(os.path.join(shell, i)) for i in conf["bundle"]["icon"]]
conf["build"]["frontendDist"] = "./frontend"
json.dump(conf, open(os.path.join(work, "tauri.conf.json"), "w"), indent=2)
PY
cp -f "$shell_dir/Cargo.lock" "$work/Cargo.lock"

cd "$work"
export CARGO_TARGET_DIR="$target"
if [ "${1:-}" = test ] && [ "$(uname)" = Darwin ]; then
  export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-undefined -C link-arg=dynamic_lookup"
fi
cargo "$@"
