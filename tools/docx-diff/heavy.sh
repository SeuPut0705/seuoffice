#!/bin/bash
# Runs one heavy command (cargo, a wasm build, the gate) at a time on this
# machine, and none between 03:28 and 05:00 KST: it waits instead. Every
# session and every subagent that shares the machine goes through it.
#
#   tools/docx-diff/heavy.sh cargo test --manifest-path crates/Cargo.toml --workspace
#   tools/docx-diff/heavy.sh npm --prefix tools/docx-diff run gate
#
# The lock is a directory outside the repository, so worktrees share it. A
# lock whose holder is gone is taken over.
lock=/tmp/heavy.lock
while :; do
  now=$((10#$(TZ=Asia/Seoul date +%H%M)))
  if [ "$now" -ge 328 ] && [ "$now" -lt 500 ]; then sleep 20; continue; fi
  if mkdir "$lock" 2>/dev/null; then echo $$ > "$lock/pid"; break; fi
  holder=$(cat "$lock/pid" 2>/dev/null)
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$lock"; continue; fi
  sleep 3
done
trap 'rm -rf "$lock"' EXIT
export PATH=/opt/homebrew/opt/rustup/bin:/opt/homebrew/opt/node@22/bin:$PATH
"$@"
