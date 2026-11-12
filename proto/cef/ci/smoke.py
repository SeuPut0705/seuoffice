#!/usr/bin/env python3
"""Smoke test of a built shell on a runner (proto/README.md contract).

  smoke.py EXE DOC OUTDIR [--probe-oscrypt SECONDS]

Runs the app twice against the 50-page mock document: BENCH_MODE=bench until
the harness writes a `done` line whose edit.saveOk is true, then BENCH_MODE=pdf
until the PDF exists. Prints the JSONL, copies it and the PDF into OUTDIR and
exits non-zero when either run fails. With --probe-oscrypt it also starts the
app once with CEF_PROBE_OSCRYPT=1 and leaves it running for SECONDS so the
caller can inspect the keychain / Local State, then kills it.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

TIMEOUT = 180
WINDOWS = sys.platform == 'win32'


def kill(proc):
    if WINDOWS:
        subprocess.run(['taskkill', '/F', '/T', '/PID', str(proc.pid)], capture_output=True)
    else:
        try:
            os.killpg(proc.pid, 9)
        except ProcessLookupError:
            pass
    try:
        proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        pass
    # helpers that outlived the browser process
    name = os.path.basename(sys.argv[1])
    if WINDOWS:
        subprocess.run(['taskkill', '/F', '/T', '/IM', name], capture_output=True)
    else:
        exe = sys.argv[1]
        root = exe.split('.app/')[0] + '.app' if '.app/' in exe else os.path.dirname(exe)
        subprocess.run(['pkill', '-9', '-f', root], capture_output=True)
    time.sleep(3)


def lines(path):
    if not os.path.exists(path):
        return []
    out = []
    for raw in open(path, encoding='utf-8'):
        raw = raw.strip()
        if raw:
            try:
                out.append(json.loads(raw))
            except ValueError:
                out.append({'kind': 'unparsed', 'raw': raw})
    return out


def run(exe, env_extra, out_jsonl, until, timeout=TIMEOUT):
    if os.path.exists(out_jsonl):
        os.remove(out_jsonl)
    env = dict(os.environ)
    env.update(env_extra)
    env['BENCH_OUT'] = out_jsonl
    env['BENCH_SHELL'] = 'cef'
    env['BENCH_T0'] = str(int(time.time() * 1000))
    kwargs = {} if WINDOWS else {'start_new_session': True}
    proc = subprocess.Popen([exe], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs)
    deadline = time.time() + timeout
    hit = None
    while time.time() < deadline:
        for line in lines(out_jsonl):
            if until(line):
                hit = line
                break
        if hit or proc.poll() is not None:
            break
        time.sleep(1)
    if hit is None:
        hit = next((l for l in lines(out_jsonl) if l.get('kind') == 'error'), None)
    code = proc.poll()
    return proc, hit, code


def pdf_pages(data):
    return len(re.findall(rb'/Type\s*/Page(?![a-zA-Z])', data))


def main():
    exe, doc, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(outdir, exist_ok=True)
    ok = True

    bench = os.path.join(outdir, 'smoke-bench.jsonl')
    proc, hit, code = run(
        exe, {'BENCH_DOC': doc, 'BENCH_MODE': 'bench'}, bench,
        lambda l: l.get('kind') in ('done', 'error'))
    kill(proc)
    print('--- bench JSONL ---')
    for line in lines(bench):
        text = json.dumps(line)
        print(text if len(text) < 4000 else text[:4000] + ' ...')
    done = hit if hit and hit.get('kind') == 'done' else None
    startup = next((l for l in lines(bench) if l.get('kind') == 'startup'), None)
    opened = next((l for l in lines(bench) if l.get('kind') == 'opened'), None)
    if not startup:
        ok = False
        print('SMOKE FAIL: no startup line')
    else:
        print('startup userDataDir:', startup.get('userDataDir'), startup.get('userDataEntries'))
    if opened:
        print('timings (ms):', json.dumps(opened.get('ms')), 'pages:', opened.get('pages'))
        print('userAgent:', opened.get('userAgent'))
    if not done or not done.get('edit', {}).get('saveOk'):
        ok = False
        print('SMOKE FAIL: no done line with edit.saveOk true (exit code %s)' % code)
    else:
        print('saveOk:', done['edit'].get('saveOk'), 'ipc:', json.dumps(done.get('ipc')))

    pdf = os.path.join(outdir, 'smoke-pdf.jsonl')
    proc, hit, code = run(
        exe, {'BENCH_DOC': doc, 'BENCH_MODE': 'pdf'}, pdf,
        lambda l: l.get('kind') in ('pdf', 'error'))
    kill(proc)
    print('--- pdf JSONL ---')
    for line in lines(pdf):
        print(json.dumps(line)[:2000])
    pdf_path = doc + '.cef.pdf'
    if not hit or hit.get('kind') != 'pdf' or not hit.get('ok'):
        ok = False
        print('SMOKE FAIL: pdf run did not report ok (exit code %s)' % code)
    if not os.path.exists(pdf_path) or os.path.getsize(pdf_path) == 0:
        ok = False
        print('SMOKE FAIL: no PDF at', pdf_path)
    else:
        data = open(pdf_path, 'rb').read()
        shutil.copy(pdf_path, os.path.join(outdir, 'smoke.pdf'))
        print('PDF: %d bytes, %d pages, header %r' % (len(data), pdf_pages(data), data[:8]))
        if not data.startswith(b'%PDF'):
            ok = False
            print('SMOKE FAIL: not a PDF')

    if '--probe-oscrypt' in sys.argv:
        seconds = int(sys.argv[sys.argv.index('--probe-oscrypt') + 1])
        probe = os.path.join(outdir, 'smoke-probe.jsonl')
        proc, _, _ = run(
            exe, {'BENCH_DOC': doc, 'BENCH_MODE': 'interactive', 'CEF_PROBE_OSCRYPT': '1'}, probe,
            lambda l: False, timeout=seconds)
        print('--- oscrypt probe JSONL (app still running) ---')
        for line in lines(probe):
            print(json.dumps(line)[:2000])
        print('probe app still running after %ds:' % seconds, proc.poll() is None)
        kill(proc)

    print('SMOKE', 'OK' if ok else 'FAILED')
    sys.exit(0 if ok else 1)


main()
