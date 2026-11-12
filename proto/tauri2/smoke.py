#!/usr/bin/env python3
"""Smoke test of a built shell on a runner (same contract for every shell).

  smoke.py <exe> <out-dir> [shell]

Runs the app twice against the 50-page mock document: BENCH_MODE=bench until the `done` line
(edit.saveOk must be true) and BENCH_MODE=pdf until the `pdf` line, then checks the PDF. Prints the
JSONL it got and writes bench.jsonl, pdf.jsonl and the PDF into <out-dir>. Exit code 1 on any failure.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zlib

sys.stdout.reconfigure(encoding="utf-8")

exe, out_dir = sys.argv[1], os.path.abspath(sys.argv[2])
shell = sys.argv[3] if len(sys.argv) > 3 else "tauri2"
here = os.path.dirname(os.path.abspath(__file__))
os.makedirs(out_dir, exist_ok=True)
work = tempfile.mkdtemp(prefix="smoke-")
doc = os.path.join(work, "bench-50p.docx")
subprocess.run([sys.executable, os.path.join(here, "..", "common", "make-doc.py"), doc], check=True)
failures = []


def kill_tree(proc):
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
    else:
        proc.kill()
    proc.wait(timeout=30)


def run(mode, kind, timeout=180):
    jsonl = os.path.join(out_dir, f"{mode}.jsonl")
    if os.path.exists(jsonl):
        os.remove(jsonl)
    env = dict(
        os.environ,
        BENCH_DOC=doc,
        BENCH_MODE=mode,
        BENCH_OUT=jsonl,
        BENCH_SHELL=shell,
        BENCH_T0=str(int(time.time() * 1000)),
    )
    proc = subprocess.Popen([exe], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    lines, deadline = [], time.time() + timeout
    try:
        while time.time() < deadline and proc.poll() is None:
            if os.path.exists(jsonl):
                lines = [json.loads(x) for x in open(jsonl, encoding="utf-8") if x.strip()]
                if any(l.get("kind") in (kind, "error") for l in lines):
                    break
            time.sleep(1)
        if os.path.exists(jsonl):
            lines = [json.loads(x) for x in open(jsonl, encoding="utf-8") if x.strip()]
        if proc.poll() is not None and not any(l.get("kind") == kind for l in lines):
            failures.append(f"{mode}: the app exited with {proc.returncode} before the {kind} line")
    finally:
        kill_tree(proc)
    print(f"--- {mode} JSONL ({jsonl})")
    for l in lines:
        print(json.dumps(l, ensure_ascii=False))
    return lines


def pdf_facts(path):
    data = open(path, "rb").read()
    pages = len(re.findall(rb"/Type\s*/Page(?![a-z])", data))
    text_ops = 0
    for m in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", data, re.S):
        try:
            body = zlib.decompress(m.group(1))
        except zlib.error:
            body = m.group(1)
        text_ops += len(re.findall(rb"\bT[jJ]\b", body))
    return {"bytes": len(data), "pages": pages, "textOps": text_ops}


bench = run("bench", "done")
startup = [l for l in bench if l.get("kind") == "startup"]
done = [l for l in bench if l.get("kind") == "done"]
if not startup:
    failures.append("bench: no startup line")
else:
    print("startup.userDataDir:", startup[0].get("userDataDir"))
if not done or done[0].get("edit", {}).get("saveOk") is not True:
    failures.append(f"bench: no done line with edit.saveOk true ({done[:1]})")

pdf_lines = run("pdf", "pdf")
pdf_line = next((l for l in pdf_lines if l.get("kind") == "pdf"), None)
pdf_path = f"{doc}.{shell}.pdf"
if pdf_line is None:
    failures.append("pdf: no pdf line")
else:
    print("pdf route result:", json.dumps(pdf_line, ensure_ascii=False))
    if pdf_line.get("ok") is True and os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 0:
        facts = pdf_facts(pdf_path)
        print("pdf facts:", json.dumps(facts))
        shutil.copy(pdf_path, os.path.join(out_dir, f"{shell}.pdf"))
        with open(os.path.join(out_dir, "pdf-facts.json"), "w") as f:
            json.dump({**facts, "route": pdf_line}, f)
        if facts["pages"] == 0 or facts["textOps"] == 0:
            failures.append(f"pdf: no pages or no text in the PDF ({facts})")
    else:
        failures.append(f"pdf: the route did not produce a PDF ({pdf_line})")

if failures:
    print("SMOKE FAILED:\n  " + "\n  ".join(failures))
    sys.exit(1)
print("SMOKE OK")
