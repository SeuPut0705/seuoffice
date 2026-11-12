#!/usr/bin/env python3
"""Reference numbers for the shipped Electron app (v0.12.37): opens the mock
document by command line, waits, reads the memory of its process tree and
takes a screenshot. The real app does not speak the bench contract, so there
is no first-paint time, only size and memory.

  python3 real-app.py --out DIR --doc DOC --installer FILE --installed DIR_OR_APP [--wait 40] -- <exe>
"""
import argparse
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bench import descendants, dir_size, memory, screenshot  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument('--out', required=True)
ap.add_argument('--doc', required=True)
ap.add_argument('--installer', action='append', default=[])
ap.add_argument('--installed')
ap.add_argument('--wait', type=int, default=40)
ap.add_argument('cmd', nargs=argparse.REMAINDER)
a = ap.parse_args()
cmd = a.cmd[1:] if a.cmd and a.cmd[0] == '--' else a.cmd
os.makedirs(a.out, exist_ok=True)
since = time.time()
proc = subprocess.Popen([*cmd, os.path.abspath(a.doc)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(a.wait)
result = {
    'shell': 'electron-app',
    'installer': {os.path.basename(p): os.path.getsize(p) for p in a.installer},
    'installed_bytes': dir_size(a.installed) if a.installed else None,
    'memory': memory(proc.pid, since),
    'screenshot': screenshot(proc.pid, since, os.path.join(a.out, 'electron-app.png')),
}
for p in descendants(proc.pid):
    try:
        p.terminate()
    except Exception:  # noqa: BLE001
        pass
time.sleep(5)
for p in descendants(proc.pid):
    try:
        p.kill()
    except Exception:  # noqa: BLE001
        pass
with open(os.path.join(a.out, 'electron-app.json'), 'w', encoding='utf-8') as f:
    json.dump(result, f, indent=1)
print(json.dumps(result, indent=1))
