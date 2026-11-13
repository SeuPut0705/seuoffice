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

The group `model` is comparison (h) instead: the documents of model-bodies.ts
through the whole parser (`npm run model -- --bodies`), for a line only
parseDocx itself runs. Such a fault is caught when an (h) line counts more
differences than without it.

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
# the lines of a group's report that say how the two sides compare
TELLING = re.compile(r"^\(f\+?\) |^key order|^ +\S+\.\S+ +checks ")
# a function's line: its name, its differences and those in key order only
FUNCTION = re.compile(r"^(\S+\.\S+) +checks +\d+ +differences +(\d+) +key order only +(\d+)")
# a line of comparison (h): its label and its differences
MODEL = re.compile(r"^(\(h\) [^\n]*?) +compared +\d+ .*?differences (\d+)(?:  \(key order only: (\d+)\))?")
# what a run of each kind of group prints when it ran
RAN = {"model": "(h) parseDocx"}


def differing(told: list[str]) -> dict[str, tuple[int, int]]:
    """The differences each function of the report shows."""
    found = (FUNCTION.match(line) or MODEL.match(line) for line in told)
    return {m.group(1): (int(m.group(2)), int(m.group(3) or 0)) for m in found if m}


def compare(group: str) -> tuple[str, list[str]]:
    """One run of the group: its whole output, and the lines that tell."""
    command = (["run", "model", "--", "--bodies"] if group == "model"
               else ["run", "calls", "--", "--group", group, "--by-function"])
    run = subprocess.run(
        ["npm", "--prefix", str(ROOT / "tools/docx-diff"), *command],
        capture_output=True, text=True)
    text = run.stdout + run.stderr
    tells = MODEL if group == "model" else TELLING
    return text, [line.strip() for line in text.splitlines() if tells.search(line)]


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
    counts = {"caught": 0, "MISSED": 0, "SET ASIDE": 0}
    # what each group reports without a fault. A fault is caught when a
    # function shows more differences than that (the tree may hold known
    # ones). A report that changed in nothing but its counts, or in the lines
    # of the listed classes, did not catch it: the fault moved inputs into a
    # class of divergences.json, where the gate does not look. That is SET
    # ASIDE, and it is a miss.
    baseline = {}
    for group in sorted({fault.get("group", spec.get("group")) for fault in faults}):
        text, baseline[group] = compare(group)
        if RAN.get(group, "(f) ") not in text:
            print(f"the group {group} does not run without a fault\n{text[-3000:]}")
            return 1
    with OUT.open("w") as out:
        for fault in faults:
            path = ROOT / fault["file"]
            original = path.read_text()
            group = fault.get("group", spec.get("group"))
            try:
                path.write_text(original.replace(fault["old"], fault["new"]))
                text, told = compare(group)
            finally:
                path.write_text(original)
            seen = [line for line in told if line not in baseline[group]]
            before = differing(baseline[group])
            more = [
                name for name, shown in differing(told).items()
                if any(now > was for now, was in zip(shown, before.get(name, (0, 0))))
            ]
            if "cargo build failed" in text or RAN.get(group, "(f) ") not in text:
                broken += 1
                verdict = "DID NOT RUN"
            else:
                verdict = "caught" if more else ("SET ASIDE" if seen else "MISSED")
                counts[verdict] += 1
            lines = [f"== {fault['name']} [{group}]: {verdict}"] + [f"   {line}" for line in seen]
            if verdict == "DID NOT RUN":
                lines.append(text[-3000:])
            report = "\n".join(lines)
            print(report, flush=True)
            out.write(report + "\n")
        summary = (
            f"faults {len(faults)}: caught {counts['caught']}, missed {counts['MISSED']}, "
            f"set aside by a listed class {counts['SET ASIDE']}, did not run {broken}"
        )
        print(summary)
        out.write(summary + "\n")
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())
