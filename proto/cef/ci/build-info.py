#!/usr/bin/env python3
"""Writes build-info.json (proto/README.md): { shell, os, exe, versions, buildSeconds }.

  build-info.py OS EXE BUILD_SECONDS OUT.json
"""
import glob
import json
import os
import re
import sys

os_name, exe, seconds, out = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
here = os.path.dirname(os.path.abspath(__file__))
lock = open(os.path.join(here, '..', 'src-tauri', 'Cargo.lock'), encoding='utf-8').read()


def crate(name):
    m = re.search(r'name = "%s"\nversion = "([^"]+)"' % re.escape(name), lock)
    return m.group(1) if m else None


versions = {name: crate(name) for name in ('tauri', 'tauri-runtime-cef', 'tauri-build')}
versions['cefCrate'] = crate('cef')
versions['tauriCli'] = json.load(open(os.path.join(here, '..', 'package.json')))['devDependencies']['@tauri-apps/cli']
cef_path = os.environ.get('CEF_PATH', '')
for archive in glob.glob(os.path.join(cef_path, '**', 'archive.json'), recursive=True):
    data = json.load(open(archive, encoding='utf-8'))
    versions['cefDistribution'] = data.get('version') or data
    m = re.search(r'chromium-([0-9.]+)', str(data.get('name') or data.get('version') or ''))
    if m:
        versions['chromium'] = m.group(1)
    m = re.search(r'cef_binary_([^_]+)_', str(data.get('name', '')))
    if m:
        versions['cef'] = m.group(1)
    break
info = {'shell': 'cef', 'os': os_name, 'exe': exe, 'versions': versions, 'buildSeconds': seconds}
json.dump(info, open(out, 'w', encoding='utf-8'), indent=2)
print(json.dumps(info, indent=2))
