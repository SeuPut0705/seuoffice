#!/usr/bin/env python3
"""Fault injection through comparison (f), one fault at a time.

    python3 tools/docx-diff/faults.py <faults.json>

The file lists changes of one line of the Rust to its naive form:

    { "group": "resolve",
      "faults": [ { "name": "...", "file": "crates/...", "old": "...", "new": "..." } ] }

A fault may name a `group` of its own. For each fault the text `old`, which has
to occur exactly once in `file`, is replaced by `new`, the group is compared
(`npm run calls -- --group <group> --by-function`) and the file is put back. A
fault the comparison does not see is MISSED: it names an input to add.

It rebuilds the wasm once per fault, so it runs on a GitHub runner, from a
throwaway branch that holds the faults file:

    gh workflow run "seuoffice rust" --ref rust-faults/<name> -f faults=<faults.json>

The result is written to tools/docx-diff/out/faults.txt, which the job keeps.
Exits 1 when a fault does not apply or does not build: such a fault says nothing.
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "tools/docx-diff/out/faults.txt"
SEEN = re.compile(r"differences +[1-9]|key order only +[1-9]|in [1-9]\d* places|BELOW FLOOR|not really compared: [1-9]")


def main() -> int:
    spec = json.loads(pathlib.Path(sys.argv[1]).read_text())
    faults = spec["faults"]
    for fault in faults:
        found = (ROOT / fault["file"]).read_text().count(fault["old"])
        if found != 1:
            print(f"{fault['name']}: the text occurs {found} times in {fault['file']}")
            return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    broken = 0
    counts = {"caught": 0, "MISSED": 0}
    with OUT.open("w") as out:
        for fault in faults:
            path = ROOT / fault["file"]
            original = path.read_text()
            group = fault.get("group", spec.get("group"))
            try:
                path.write_text(original.replace(fault["old"], fault["new"]))
                run = subprocess.run(
                    ["npm", "--prefix", str(ROOT / "tools/docx-diff"), "run", "calls", "--",
                     "--group", group, "--by-function"],
                    capture_output=True, text=True)
            finally:
                path.write_text(original)
            text = run.stdout + run.stderr
            seen = [line.strip() for line in text.splitlines() if SEEN.search(line)]
            if "cargo build failed" in text or "(f) " not in text:
                broken += 1
                verdict = "DID NOT RUN"
            else:
                verdict = "caught" if seen else "MISSED"
                counts[verdict] += 1
            lines = [f"== {fault['name']} [{group}]: {verdict}"] + [f"   {line}" for line in seen]
            if verdict == "DID NOT RUN":
                lines.append(text[-3000:])
            report = "\n".join(lines)
            print(report, flush=True)
            out.write(report + "\n")
        summary = f"faults {len(faults)}: caught {counts['caught']}, missed {counts['MISSED']}, did not run {broken}"
        print(summary)
        out.write(summary + "\n")
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())
