#!/usr/bin/env python3
"""Turns the bench results of one runner into a Markdown table and image diffs.

  python3 report.py DIR [os-label]

DIR holds <shell>.json from bench.py (electron, tauri2, cef, electron-app ...),
their screenshots and PDF page renders. Screenshots and PDF pages are compared
with electron's: the share of pixels whose largest channel differs by more
than 32 and the mean absolute difference; a diff image is written beside them.
"""
import json
import os
import statistics
import sys

import numpy as np
from PIL import Image


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def diff(a_path, b_path, out_path):
    """Pixel difference after the best small shift (window chrome can differ by a few pixels)."""
    if not (os.path.exists(a_path) and os.path.exists(b_path)):
        return None
    a_img = Image.open(a_path).convert('RGB')
    b_img = Image.open(b_path).convert('RGB')
    a_full = np.asarray(a_img, dtype=np.int16)
    b_full = np.asarray(b_img, dtype=np.int16)
    best = None
    for dy in range(-8, 9):
        for dx in range(-4, 5):
            ay, by = max(0, dy), max(0, -dy)
            ax, bx = max(0, dx), max(0, -dx)
            h = min(a_full.shape[0] - ay, b_full.shape[0] - by)
            w = min(a_full.shape[1] - ax, b_full.shape[1] - bx)
            a = a_full[ay:ay + h, ax:ax + w]
            b = b_full[by:by + h, bx:bx + w]
            mean = float(np.abs(a - b).mean())
            if best is None or mean < best[0]:
                best = (mean, dy, dx, a, b)
    mean, dy, dx, a, b = best
    d = np.abs(a - b).max(axis=2)
    changed = d > 32
    vis = np.where(changed[..., None], np.array([255, 0, 0], dtype=np.uint8), (a // 3).astype(np.uint8))
    Image.fromarray(vis.astype(np.uint8)).save(out_path)
    return {
        'size_a': list(a_img.size),
        'size_b': list(b_img.size),
        'shift': [dx, dy],
        'changed_pct': round(100 * changed.mean(), 2),
        'mean_abs': round(mean, 2),
    }


def page_diff(a_path, b_path, out_path):
    """The document page area only: a crop of electron's window searched for in the candidate's
    over a wide shift, since window chrome (Electron's menu bar on Windows) moves the content."""
    if not (os.path.exists(a_path) and os.path.exists(b_path)):
        return None
    a_full = np.asarray(Image.open(a_path).convert('RGB'), dtype=np.int16)
    b_full = np.asarray(Image.open(b_path).convert('RGB'), dtype=np.int16)
    h, w = a_full.shape[:2]
    y0, y1, x0, x1 = int(h * 0.3), int(h * 0.85), int(w * 0.38), int(w * 0.92)
    a = a_full[y0:y1, x0:x1]
    best = None
    for dy in range(-60, 61, 1):
        for dx in range(-24, 25, 1):
            by, bx = y0 + dy, x0 + dx
            if by < 0 or bx < 0 or by + a.shape[0] > b_full.shape[0] or bx + a.shape[1] > b_full.shape[1]:
                continue
            b = b_full[by:by + a.shape[0], bx:bx + a.shape[1]]
            mean = float(np.abs(a[::4, ::4] - b[::4, ::4]).mean())
            if best is None or mean < best[0]:
                best = (mean, dy, dx)
    if best is None:
        return None
    _, dy, dx = best
    b = b_full[y0 + dy:y0 + dy + a.shape[0], x0 + dx:x0 + dx + a.shape[1]]
    changed = np.abs(a - b).max(axis=2) > 32
    vis = np.where(changed[..., None], np.array([255, 0, 0], dtype=np.uint8), (a // 3).astype(np.uint8))
    Image.fromarray(vis.astype(np.uint8)).save(out_path)
    return {'crop': [x0, y0, x1, y1], 'shift': [dx, dy], 'changed_pct': round(100 * changed.mean(), 2),
            'mean_abs': round(float(np.abs(a - b).mean()), 2)}


def med(values):
    values = [v for v in values if v is not None]
    return round(statistics.median(values)) if values else None


def mb(v):
    return None if v is None else round(v / 1e6, 1)


def summarize(r):
    runs = r.get('runs', [])
    ok = [x for x in runs if 'opened' in x]
    warm = ok[1:] if len(ok) > 1 else ok
    first = ok[0] if ok and ok[0].get('run') == 1 else None
    ms = lambda x, k: x['opened']['ms'].get(k)  # noqa: E731
    done = [x['done'] for x in runs if 'done' in x]
    ipc = lambda k: med([d['ipc'][k]['median'] for d in done]) if done else None  # noqa: E731
    ipc10 = [d['ipc']['10MB']['median'] for d in done]
    return {
        'installer_mb': {k: mb(v) for k, v in r.get('installer', {}).items()},
        'installed_mb': mb(r.get('installed_bytes')),
        'first_paint_cold_ms': ms(first, 'firstPaint') if first else None,
        'first_paint_warm_ms': med([ms(x, 'firstPaint') for x in warm]),
        'settled_warm_ms': med([ms(x, 'settled') for x in warm]),
        'pages': ok[-1]['opened'].get('pages') if ok else None,
        'rss_mb': mb(med([x['memory']['rss'] for x in warm if 'memory' in x])),
        'private_mb': mb(med([x['memory']['private'] for x in warm if 'memory' in x])),
        'processes': med([x['memory']['processes'] for x in warm if 'memory' in x]),
        'ipc_1kb_ms': None if not done else round(statistics.median([d['ipc']['1KB']['median'] for d in done]), 3),
        'ipc_10mb_ms': None if not ipc10 else round(statistics.median(ipc10), 1),
        'ipc_intact': all(d['ipc'][k]['intact'] for d in done for k in ('1KB', '10MB')) if done else None,
        'edit_typed': all(d['edit'].get('typed') for d in done) if done else None,
        'save_ok': all(d['edit'].get('saveOk') for d in done) if done else None,
        'errors': [x['error'] for x in runs if 'error' in x],
        'pdf': r.get('pdf', {}).get('file') or {k: v for k, v in r.get('pdf', {}).items() if k != 'lines'},
        'fonts': ok[-1]['opened'].get('fonts') if ok else None,
        'user_agent': ok[-1]['opened'].get('userAgent') if ok else None,
    }


def main():
    d = sys.argv[1]
    label = sys.argv[2] if len(sys.argv) > 2 else ''
    results = {}
    for name in sorted(os.listdir(d)):
        if name.endswith('.json') and not name.startswith('summary'):
            r = load(os.path.join(d, name))
            if isinstance(r, dict) and 'runs' in r:
                results[r['shell']] = r
    summary = {s: summarize(r) for s, r in results.items()}
    for s, r in results.items():
        if s == 'electron':
            continue
        last = max((x['run'] for x in r['runs'] if 'screenshot' in x), default=None)
        if last:
            summary[s]['screenshot_vs_electron'] = diff(
                os.path.join(d, f'electron-run{last}.png'),
                os.path.join(d, f'{s}-run{last}.png'),
                os.path.join(d, f'diff-{s}-vs-electron.png'),
            )
            summary[s]['page_area_vs_electron'] = page_diff(
                os.path.join(d, f'electron-run{last}.png'),
                os.path.join(d, f'{s}-run{last}.png'),
                os.path.join(d, f'diff-page-{s}-vs-electron.png'),
            )
        summary[s]['pdf_p1_vs_electron'] = diff(
            os.path.join(d, 'electron-p1.png'),
            os.path.join(d, f'{s}-p1.png'),
            os.path.join(d, f'diff-pdf-{s}-vs-electron.png'),
        )
    with open(os.path.join(d, 'summary.json'), 'w', encoding='utf-8') as f:
        json.dump(summary, f, indent=1, ensure_ascii=False)

    rows = [
        ('installer MB', lambda s: s['installer_mb']),
        ('installed MB', lambda s: s['installed_mb']),
        ('first paint cold ms', lambda s: s['first_paint_cold_ms']),
        ('first paint warm ms (median)', lambda s: s['first_paint_warm_ms']),
        ('layout settled warm ms', lambda s: s['settled_warm_ms']),
        ('pages laid out', lambda s: s['pages']),
        ('RSS MB after open', lambda s: s['rss_mb']),
        ('private MB after open (win USS, mac footprint)', lambda s: s['private_mb']),
        ('processes', lambda s: s['processes']),
        ('IPC 1 KB ms', lambda s: s['ipc_1kb_ms']),
        ('IPC 10 MB ms', lambda s: s['ipc_10mb_ms']),
        ('edit + save', lambda s: f"typed={s['edit_typed']} saved={s['save_ok']}"),
        ('PDF', lambda s: s['pdf']),
        ('screenshot vs electron', lambda s: s.get('screenshot_vs_electron')),
        ('page area vs electron', lambda s: s.get('page_area_vs_electron')),
        ('PDF p1 vs electron', lambda s: s.get('pdf_p1_vs_electron')),
        ('errors', lambda s: s['errors']),
    ]
    shells = list(summary)
    lines = [f'### {label}', '', '| | ' + ' | '.join(shells) + ' |', '|---' * (len(shells) + 1) + '|']
    for title, get in rows:
        cells = []
        for s in shells:
            try:
                v = get(summary[s])
            except (KeyError, TypeError):
                v = None
            cells.append(json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else str(v))
        lines.append(f'| {title} | ' + ' | '.join(cells) + ' |')
    md = '\n'.join(lines) + '\n'
    with open(os.path.join(d, 'summary.md'), 'w', encoding='utf-8') as f:
        f.write(md)
    print(md)


if __name__ == '__main__':
    main()
