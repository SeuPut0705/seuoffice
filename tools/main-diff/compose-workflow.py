#!/usr/bin/env python3
"""Compose .github/workflows/seuoffice-rust.yml for the stage 2 branch.

main owns the workflow; the stage 2 branch adds the central process to it:
the `main_faults` input, the comparison steps at the end of main's `crates`
job, and the `main-windows` and `main-faults` jobs.
Run after every merge of main, then check `git diff origin/main` of the file:

    git show origin/main:.github/workflows/seuoffice-rust.yml > "$SCRATCH/main.yml"
    python3 tools/main-diff/compose-workflow.py "$SCRATCH/main.yml" \
        tools/main-diff/workflow-additions.txt > "$SCRATCH/composed.yml"
"""

import re
import sys


def section(text: str, name: str) -> str:
    """One `# --- name` section of the additions file, without its marker."""
    match = re.search(rf"^# --- {name}\n(.*?)(?=^# --- |\Z)", text, re.S | re.M)
    if not match:
        sys.exit(f"additions: no section {name}")
    return match.group(1).rstrip("\n") + "\n"


def insert_after(text: str, anchor: str, addition: str) -> str:
    if text.count(anchor) != 1:
        sys.exit(f"main workflow: anchor not found once: {anchor!r}")
    return text.replace(anchor, anchor + addition)


def end_of_job(text: str, job: str) -> int:
    """The offset just past the last line of a job."""
    start = text.index(f"\n  {job}:\n") + 1
    following = re.search(r"^\n(  #.*\n)*  [a-z][a-z0-9-]*:\n", text[start:], re.M)
    return start + following.start() if following else len(text)


def main() -> None:
    workflow = open(sys.argv[1]).read()
    additions = open(sys.argv[2]).read()

    workflow = insert_after(
        workflow,
        "    inputs:\n",
        section(additions, "inputs"),
    )
    crates_end = end_of_job(workflow, "crates")
    workflow = (
        workflow[:crates_end].rstrip("\n")
        + "\n\n"
        + section(additions, "crates-steps")
        + workflow[crates_end:]
    )
    workflow = workflow.rstrip("\n") + "\n\n" + section(additions, "jobs")
    sys.stdout.write(workflow)


main()
