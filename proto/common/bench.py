#!/usr/bin/env python3
"""Measures one shell on this machine against the contract in proto/README.md.

  python3 bench.py --shell tauri2 --out DIR --doc DOC [--runs 6] -- <command...>

Run 1 is the first launch on this runner (cold profile; the OS file cache may
be warm from installing). Runs 2..N reuse the profile. Each bench run: launch
with BENCH_T0 = the epoch milliseconds just before spawning, wait for the
`opened` line, wait 3 s, read the memory of the process tree (on macOS plus
the WebKit XPC processes that started after the launch, which launchd owns),
take a window screenshot, wait for `done`, kill the tree. Then one pdf run.
Writes DIR/<shell>.json and the screenshots and PDF next to it.
"""
import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import time

import psutil

IS_MAC = sys.platform == 'darwin'
IS_WIN = sys.platform == 'win32'


def read_lines(path):
    try:
        with open(path, encoding='utf-8') as f:
            return [json.loads(line) for line in f if line.strip()]
    except FileNotFoundError:
        return []


def wait_line(path, kind, proc, timeout):
    end = time.time() + timeout
    while time.time() < end:
        for line in read_lines(path):
            if line.get('kind') == kind:
                return line
            if line.get('kind') == 'error':
                raise RuntimeError(f'page error: {line.get("error")}')
        if proc.poll() is not None and kind != 'startup':
            raise RuntimeError(f'process exited with {proc.returncode} before {kind}')
        time.sleep(0.05)
    raise TimeoutError(f'no {kind} line within {timeout}s')


def descendants(pid):
    """The launched process and its children: the only processes teardown may kill."""
    try:
        root = psutil.Process(pid)
        return [root, *root.children(recursive=True)]
    except psutil.NoSuchProcess:
        return []


def tree(pid, since):
    """For memory: descendants, plus on a CI runner the WebKit XPC processes started since the launch."""
    procs = {p.pid: p for p in descendants(pid)}
    if IS_MAC and os.environ.get('CI'):
        # WKWebView's content, GPU and network processes are XPC services under launchd, so they are
        # no descendants; an ephemeral runner has no other WebKit user, a shared Mac does
        for p in psutil.process_iter(['name', 'create_time']):
            try:
                if 'com.apple.WebKit' in (p.info['name'] or '') and p.info['create_time'] >= since - 1:
                    procs[p.pid] = p
            except psutil.Error:
                pass
    return list(procs.values())


def mac_footprints(pids):
    """phys_footprint per process (what Activity Monitor calls Memory), from /usr/bin/footprint"""
    import re

    args = ['footprint']
    for p in pids:
        args += ['-p', str(p)]
    text = subprocess.run(args, capture_output=True, text=True).stdout
    unit = {'B': 1, 'KB': 1024, 'MB': 1024**2, 'GB': 1024**3}
    out = {}
    for m in re.finditer(r'\[(\d+)\]: .*?Footprint: ([\d.]+) (B|KB|MB|GB)', text):
        out[int(m.group(1))] = int(float(m.group(2)) * unit[m.group(3)])
    return out


def memory(pid, since):
    """rss: sum of resident sets (shared pages counted per process); private: Windows USS, macOS phys_footprint"""
    out = {'processes': 0, 'rss': 0, 'private': 0, 'private_missing': 0, 'names': {}}
    procs = tree(pid, since)
    footprints = mac_footprints([p.pid for p in procs]) if IS_MAC else {}
    for p in procs:
        try:
            name = p.name()
            rss = p.memory_info().rss
        except psutil.Error:
            continue
        out['processes'] += 1
        out['rss'] += rss
        out['names'][name] = out['names'].get(name, 0) + 1
        try:
            out['private'] += footprints[p.pid] if IS_MAC else p.memory_full_info().uss
        except (KeyError, psutil.Error):
            out['private_missing'] += 1
    return out


def kill_tree(proc, since):
    procs = descendants(proc.pid)
    for p in procs:
        try:
            p.kill()
        except psutil.Error:
            pass
    psutil.wait_procs(procs, timeout=10)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


def screenshot(pid, since, path):
    pids = {p.pid for p in tree(pid, since)}
    if IS_MAC:
        import Quartz

        windows = Quartz.CGWindowListCopyWindowInfo(
            Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID
        )
        best = None
        for w in windows:
            if w.get('kCGWindowOwnerPID') not in pids or w.get('kCGWindowLayer', 0) != 0:
                continue
            b = w['kCGWindowBounds']
            area = b['Width'] * b['Height']
            if not best or area > best[0]:
                best = (area, w['kCGWindowNumber'])
        if not best:
            return {'ok': False, 'error': 'no window'}
        r = subprocess.run(['screencapture', '-x', '-o', '-l', str(best[1]), path], capture_output=True)
        return {'ok': r.returncode == 0 and os.path.exists(path), 'error': r.stderr.decode()[-300:]}
    if IS_WIN:
        import ctypes
        from ctypes import wintypes

        from PIL import ImageGrab

        user32 = ctypes.windll.user32
        found = []

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def cb(hwnd, _):
            if not user32.IsWindowVisible(hwnd):
                return True
            owner = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            if owner.value in pids:
                rect = wintypes.RECT()
                ctypes.windll.dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(rect), ctypes.sizeof(rect))
                area = (rect.right - rect.left) * (rect.bottom - rect.top)
                found.append((area, hwnd, (rect.left, rect.top, rect.right, rect.bottom)))
            return True

        user32.EnumWindows(cb, 0)
        if not found:
            return {'ok': False, 'error': 'no window'}
        _, hwnd, box = max(found)
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.5)
        ImageGrab.grab(bbox=box, all_screens=True).save(path)
        return {'ok': True, 'box': box}
    return {'ok': False, 'error': 'unsupported OS'}


def dir_size(path):
    if os.path.isfile(path):
        return os.path.getsize(path)
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            fp = os.path.join(root, f)
            if not os.path.islink(fp):
                total += os.path.getsize(fp)
    return total


def launch(cmd, env_extra, out_jsonl):
    env = dict(os.environ)
    env.update(env_extra)
    env['BENCH_OUT'] = out_jsonl
    if os.path.exists(out_jsonl):
        os.remove(out_jsonl)
    since = time.time()
    env['BENCH_T0'] = repr(since * 1000)
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return proc, since


def pdf_info(path):
    try:
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(path)
        info = {'pages': len(pdf), 'bytes': os.path.getsize(path)}
        page = pdf[0]
        info['page1_size_pt'] = [round(v, 1) for v in page.get_size()]
        info['page1_chars'] = page.get_textpage().count_chars()
        page.render(scale=1.5).to_pil().save(path[:-4] + '-p1.png')
        return info
    except Exception as e:  # noqa: BLE001 - a bad PDF is a finding
        return {'error': str(e)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--shell', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--doc', required=True)
    ap.add_argument('--runs', type=int, default=6)
    ap.add_argument('--env', action='append', default=[])
    ap.add_argument('--installer', action='append', default=[], help='file whose size is the download')
    ap.add_argument('--installed', help='installed folder or .app')
    ap.add_argument('--no-screenshot', action='store_true', help='local runs: no screen capture prompt')
    ap.add_argument('cmd', nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == '--' else a.cmd
    os.makedirs(a.out, exist_ok=True)
    doc = os.path.abspath(a.doc)
    base_env = dict(kv.split('=', 1) for kv in a.env)
    base_env['BENCH_SHELL'] = a.shell
    result = {
        'shell': a.shell,
        'os': f'{platform.system()} {platform.release()} {platform.machine()}',
        'cpu_count': os.cpu_count(),
        'cmd': cmd,
        'installer': {os.path.basename(p): os.path.getsize(p) for p in a.installer},
        'installed_bytes': dir_size(a.installed) if a.installed else None,
        'runs': [],
    }
    for i in range(a.runs):
        jsonl = os.path.join(a.out, f'{a.shell}-run{i + 1}.jsonl')
        run = {'run': i + 1}
        proc, since = launch(cmd, {**base_env, 'BENCH_DOC': doc, 'BENCH_MODE': 'bench'}, jsonl)
        try:
            opened = wait_line(jsonl, 'opened', proc, 240)
            run['opened'] = opened
            time.sleep(3)
            run['memory'] = memory(proc.pid, since)
            if not a.no_screenshot and (i == 0 or i == a.runs - 1):
                shot = os.path.join(a.out, f'{a.shell}-run{i + 1}.png')
                run['screenshot'] = {'file': os.path.basename(shot), **screenshot(proc.pid, since, shot)}
            run['done'] = wait_line(jsonl, 'done', proc, 240)
        except Exception as e:  # noqa: BLE001 - recorded, the next run still goes
            run['error'] = str(e)
        finally:
            run['lines'] = read_lines(jsonl)
            kill_tree(proc, since)
            time.sleep(2)
        result['runs'].append(run)
        print(json.dumps({k: run.get(k) for k in ('run', 'error')} | {'ms': run.get('opened', {}).get('ms')}))

    pdf_path = doc + f'.{a.shell}.pdf'
    jsonl = os.path.join(a.out, f'{a.shell}-pdf.jsonl')
    proc, since = launch(cmd, {**base_env, 'BENCH_DOC': doc, 'BENCH_MODE': 'pdf'}, jsonl)
    try:
        result['pdf'] = wait_line(jsonl, 'pdf', proc, 300)
        if os.path.exists(pdf_path):
            dest = os.path.join(a.out, f'{a.shell}.pdf')
            shutil.copy(pdf_path, dest)
            result['pdf']['file'] = pdf_info(dest)
    except Exception as e:  # noqa: BLE001
        result['pdf'] = {'error': str(e), 'lines': read_lines(jsonl)}
    finally:
        kill_tree(proc, since)

    with open(os.path.join(a.out, f'{a.shell}.json'), 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=1, ensure_ascii=False)
    print(f'wrote {a.shell}.json')


if __name__ == '__main__':
    main()
