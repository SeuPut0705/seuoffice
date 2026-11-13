#!/usr/bin/env bash
# Runs every TLC run of a formal model's matrix and checks each against its expected
# verdict: "pass" (no error), "invariant" (that invariant violated) or "temporal" (a
# temporal property violated). Flags follow the formal-verify skill's own TLC call.
# Usage: run-matrix.sh <tla dir> <spec.tla> <matrix.json> <classpath>
set -euo pipefail
dir=$1 spec=$2 matrix=$3 classpath=$4
cd "$dir"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
fail=0
while IFS= read -r run; do
  name=$(jq -r .name <<<"$run")
  config=$(jq -r .config <<<"$run")
  expect=$(jq -r .expect <<<"$run")
  property=$(jq -r '.property // ""' <<<"$run")
  timeout=$(jq -r '.timeoutSec // 3600' <<<"$run")
  workers=$(jq -r '.workers // 1' <<<"$run")
  cfg=$PWD/$config
  if jq -e '.constants' <<<"$run" >/dev/null; then
    cfg=$scratch/$name.cfg
    cp "$config" "$cfg"
    while IFS=$'\t' read -r key value; do
      sed -i -E "s/^([[:space:]]*${key}[[:space:]]*=).*/\\1 ${value}/" "$cfg"
    done < <(jq -r '.constants | to_entries[] | [.key, .value] | @tsv' <<<"$run")
  fi
  log=$scratch/$name.log
  set +e
  timeout "$timeout" java -XX:+UseParallelGC -Dfile.encoding=UTF-8 -Djava.io.tmpdir="$scratch" \
    -cp "$classpath" tlc2.TLC -noTE -workers "$workers" -metadir "$scratch/states-$name" \
    -config "$cfg" "$spec" >"$log" 2>&1
  code=$?
  set -e
  case $expect in
    pass) grep -q 'No error has been found' "$log" && ok=1 || ok=0 ;;
    invariant) grep -q "Invariant ${property} is violated" "$log" && ok=1 || ok=0 ;;
    temporal) grep -q 'Temporal properties were violated' "$log" && ok=1 || ok=0 ;;
    *) ok=0 ;;
  esac
  rm -rf "$scratch/states-$name"
  if [ "$ok" = 1 ]; then
    echo "ok   $name ($expect${property:+ $property})"
  else
    echo "FAIL $name: expected $expect${property:+ $property}, exit $code"
    tail -40 "$log"
    fail=1
  fi
done < <(jq -c '.runs[]' "$matrix")
exit "$fail"
