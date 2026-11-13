#!/usr/bin/env python3
"""Compose .github/workflows/seuoffice-rust.yml for the stage 2 branch.

main owns the workflow; the stage 2 branch adds the central process to it:
the `main_faults` and `skip_pptx_faults` inputs, the comparison steps at the
end of main's `crates` job, and the `main-windows` and `main-faults` jobs.
Run after every merge of main, then check `git diff origin/main` of the file:

    git show origin/main:.github/workflows/seuoffice-rust.yml > /tmp/main.yml
    python3 tools/main-diff/compose-workflow.py /tmp/main.yml \
        tools/main-diff/workflow-additions.txt > .github/workflows/seuoffice-rust.yml
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
    # the slides fault shards keep main's condition and add the branch's skip
    faults_at = workflow.index("\n  pptx-faults:\n")
    guard = re.compile(r"^    if: \$\{\{ (.*) \}\}\n", re.M).search(workflow, faults_at)
    if not guard:
        sys.exit("main workflow: pptx-faults has no if")
    workflow = (
        workflow[: guard.start()]
        + f"    if: ${{{{ {guard.group(1)} && !inputs.skip_pptx_faults }}}}\n"
        + workflow[guard.end() :]
    )
    workflow = workflow.rstrip("\n") + "\n\n" + section(additions, "jobs")
    sys.stdout.write(workflow)


main()
