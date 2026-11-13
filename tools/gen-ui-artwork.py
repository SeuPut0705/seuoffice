#!/usr/bin/env python3
"""Draw the AI-panel buttons, the AI ribbon icons, the slide fill textures and
the Home icon of the native tab menu.

These replace drawings that came with the original repository without a record
of where they came from. Everything here is drawn from code, so the files are
this project's own work. Run from the repository root:

    python3 tools/gen-ui-artwork.py

Needs Pillow and NumPy. The output is deterministic: a fixed seed per texture.
Every texture tiles seamlessly (periodic noise and integer frequencies).
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SS = 8  # supersampling factor for the vector drawings

BLUE = (17, 127, 255, 255)
BLACK = (0, 0, 0, 255)
GREY = (144, 148, 153, 255)
WHITE = (255, 255, 255, 255)
OFF_FILL = (244, 244, 244, 255)

# ── vector helpers ─────────────────────────────────────────────────────────


def line(a, b):
    return [a, b]


def arc(cx, cy, r, start, end, steps=48):
    """Points from angle `start` to `end` (degrees, screen coordinates: 90 is down)."""
    return [
        (cx + r * math.cos(math.radians(start + (end - start) * i / steps)),
         cy + r * math.sin(math.radians(start + (end - start) * i / steps)))
        for i in range(steps + 1)
    ]


class Canvas:
    """Draws in a `size` unit box at SS x resolution, saved downsampled."""

    def __init__(self, size: int, units: float):
        self.size = size
        self.k = size * SS / units
        self.im = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.im)

    def p(self, pts):
        return [(x * self.k, y * self.k) for x, y in pts]

    def stroke(self, *segments, width: float, fill, closed: bool = False):
        pts: list[tuple[float, float]] = []
        for seg in segments:
            pts.extend(seg)
        pts = self.p(pts)
        if closed:
            pts.append(pts[0])
        w = width * self.k
        self.d.line(pts, fill=fill, width=round(w), joint='curve')
        if not closed:
            for x, y in (pts[0], pts[-1]):
                self.d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=fill)

    def round_rect(self, x0, y0, x1, y1, r, fill):
        self.d.rounded_rectangle(
            (x0 * self.k, y0 * self.k, x1 * self.k, y1 * self.k), radius=r * self.k, fill=fill
        )

    def polygon(self, pts, fill):
        self.d.polygon(self.p(pts), fill=fill)

    def save(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.im.resize((self.size, self.size), Image.LANCZOS).save(path, optimize=True)


def sparkle_points(cx, cy, r, inner=0.28, steps=12):
    """A four-pointed star whose sides curve inwards."""
    pts = []
    for tip in range(4):
        a0 = math.radians(tip * 90 - 90)
        a1 = math.radians(tip * 90)
        p0 = (cx + r * math.cos(a0), cy + r * math.sin(a0))
        p1 = (cx + r * math.cos(a1), cy + r * math.sin(a1))
        mid = (a0 + a1) / 2
        ctrl = (cx + r * inner * math.cos(mid), cy + r * inner * math.sin(mid))
        for i in range(steps):
            t = i / steps
            pts.append((
                (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * ctrl[0] + t * t * p1[0],
                (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * ctrl[1] + t * t * p1[1],
            ))
    return pts


# ── AI panel buttons (240 x 240 and 80 x 80) ───────────────────────────────


def send_button(path: Path, back, glyph):
    c = Canvas(240, 24)
    c.round_rect(0, 0, 24, 24, 7.2, back)
    # a return arrow: down from the top right, then left
    c.stroke(line((16.5, 6), (16.5, 10.5)), arc(13.5, 10.5, 3, 0, 90),
             line((13.5, 13.5), (6.5, 13.5)), width=1.6, fill=glyph)
    c.stroke(line((9.8, 10.2), (6.5, 13.5)), line((6.5, 13.5), (9.8, 16.8)), width=1.6, fill=glyph)
    c.save(path)


def stop_button(path: Path):
    c = Canvas(240, 24)
    c.round_rect(0, 0, 24, 24, 7.2, BLACK)
    c.round_rect(8.2, 8.2, 15.8, 15.8, 1.6, WHITE)
    c.save(path)


def attach_icon(path: Path):
    c = Canvas(80, 80)
    c.stroke(
        line((47, 30), (47, 52)), arc(40.5, 52, 6.5, 0, 180),
        line((34, 52), (34, 18)), arc(44, 18, 10, 180, 360),
        line((54, 18), (54, 56)), arc(40, 56, 14, 0, 180),
        line((26, 56), (26, 26)),
        width=5, fill=GREY,
    )
    c.save(path)


# ── AI ribbon icons (44 x 44 on a 24-unit grid) ────────────────────────────


def letter_a(c: Canvas, x0, y0, w, h, fill, width=2):
    top = (x0 + w / 2, y0)
    c.stroke(line((x0, y0 + h), top), line(top, (x0 + w, y0 + h)), width=width, fill=fill)
    c.stroke(line((x0 + w * 0.22, y0 + h * 0.62), (x0 + w * 0.78, y0 + h * 0.62)), width=width, fill=fill)


def icon_editor(path: Path):
    c = Canvas(44, 24)
    c.polygon(sparkle_points(5, 5, 3.6), BLUE)
    # a pencil from the bottom left to the top right
    c.stroke(line((6, 21), (6.6, 17.6)), line((6.6, 17.6), (17, 7.2)),
             arc(18.6, 8.8, 2.25, 225, 405), line((20.2, 10.4), (9.8, 20.8)),
             line((9.8, 20.8), (6, 21)), width=1.8, fill=BLUE)
    c.stroke(line((14.6, 9.6), (17.8, 12.8)), width=1.8, fill=BLUE)
    c.save(path)


def icon_translate(path: Path):
    c = Canvas(44, 24)
    sp = sparkle_points(7, 7, 5)
    c.stroke(sp, width=1.6, fill=BLUE, closed=True)
    # corner brackets: top right and bottom left
    c.stroke(line((14, 2.5), (18.5, 2.5)), arc(18.5, 5.5, 3, 270, 360), line((21.5, 5.5), (21.5, 8)),
             width=1.8, fill=BLUE)
    c.stroke(line((2.5, 15), (2.5, 18.5)), arc(5.5, 18.5, 3, 180, 90), line((5.5, 21.5), (9, 21.5)),
             width=1.8, fill=BLUE)
    letter_a(c, 12, 12, 9, 9.5, BLUE, width=1.9)
    c.save(path)


def icon_crop(path: Path):
    c = Canvas(44, 24)
    c.stroke(line((6, 2), (6, 16)), arc(8, 16, 2, 180, 90), line((8, 18), (22, 18)), width=1.9, fill=BLACK)
    c.stroke(line((18, 22), (18, 8)), arc(16, 8, 2, 0, -90), line((16, 6), (2, 6)), width=1.9, fill=BLACK)
    c.save(path)


def icon_spelling(path: Path):
    c = Canvas(44, 24)
    letter_a(c, 2.5, 2, 8, 9, BLUE)
    # a lower-case a: a bowl and a stem
    c.stroke(arc(16.5, 8, 3, 0, 360), width=2, fill=BLUE, closed=True)
    c.stroke(line((19.5, 4.5), (19.5, 11)), width=2, fill=BLUE)
    c.stroke(line((2.5, 15), (14, 15)), width=1.8, fill=BLUE)
    c.stroke(line((2.5, 19.5), (9.5, 19.5)), width=1.8, fill=BLUE)
    c.stroke(line((13, 19), (15.5, 21.5)), line((15.5, 21.5), (21, 16)), width=1.9, fill=BLUE)
    c.save(path)


def icon_transparency(path: Path):
    c = Canvas(44, 24)
    # the overlap of the two discs, hatched
    hatch = Image.new('L', c.im.size, 0)
    hd = ImageDraw.Draw(hatch)
    for k in range(-30, 60, 2):
        hd.line([(k * c.k, 0), ((k - 24) * c.k, 24 * c.k)], fill=255, width=round(0.9 * c.k))
    lens = Image.new('L', c.im.size, 0)
    m1 = Image.new('L', c.im.size, 0)
    ImageDraw.Draw(m1).ellipse(tuple(v * c.k for v in (2, 2, 16, 16)), fill=255)
    m2 = Image.new('L', c.im.size, 0)
    ImageDraw.Draw(m2).ellipse(tuple(v * c.k for v in (8, 8, 22, 22)), fill=255)
    lens = Image.fromarray(np.minimum(np.minimum(np.array(m1), np.array(m2)), np.array(hatch)))
    c.im.paste(Image.new('RGBA', c.im.size, BLACK), (0, 0), lens)
    c.stroke(arc(9, 9, 7, 0, 360), width=1.8, fill=BLACK, closed=True)
    c.stroke(arc(15, 15, 7, 0, 360), width=1.8, fill=BLACK, closed=True)
    c.save(path)


# ── the Home item of the native tab menu (16 x 16 and its 2x) ─────────────

MENU_GREY = (69, 71, 70, 255)


def menu_home(path: Path, size: int):
    c = Canvas(size, 16)
    c.stroke(line((2.5, 7), (8, 2.2)), line((8, 2.2), (13.5, 7)), line((13.5, 7), (13.5, 13.6)),
             line((13.5, 13.6), (2.5, 13.6)), line((2.5, 13.6), (2.5, 7)),
             width=1.4, fill=MENU_GREY, closed=True)
    c.round_rect(7.2, 9.6, 8.8, 11.2, 0.3, MENU_GREY)
    c.save(path)


# ── slide fill textures (128 x 128, tiling) ────────────────────────────────

N = 128
YY, XX = np.mgrid[0:N, 0:N]


def periodic_noise(rng, scale: float) -> np.ndarray:
    """Smooth noise in [0, 1] that wraps at the edges: low-passed white noise."""
    f = np.fft.fft2(rng.standard_normal((N, N)))
    fy = np.fft.fftfreq(N)[:, None]
    fx = np.fft.fftfreq(N)[None, :]
    f *= np.exp(-(fx ** 2 + fy ** 2) * (scale ** 2) * 40)
    n = np.real(np.fft.ifft2(f))
    return (n - n.min()) / (n.max() - n.min())


def colourise(v: np.ndarray, dark, light) -> np.ndarray:
    dark = np.array(dark, dtype=float)
    light = np.array(light, dtype=float)
    rgb = dark[None, None, :] + (light - dark)[None, None, :] * np.clip(v, 0, 1)[..., None]
    return rgb


def save_texture(path: Path, rgb: np.ndarray):
    a = np.clip(np.rint(rgb), 0, 255).astype(np.uint8)
    alpha = np.full((N, N, 1), 255, dtype=np.uint8)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.concatenate([a, alpha], axis=2)).save(path, optimize=True)


def textures(out: Path):
    rng = np.random.default_rng(20261113)

    weave = 0.55 + 0.25 * ((XX % 4 == 0) | (YY % 4 == 0)) * -1 + 0.2 * periodic_noise(rng, 1)
    save_texture(out / 'canvas.png', colourise(weave, (196, 186, 160), (238, 232, 214)))

    cork = 0.55 * periodic_noise(rng, 8) + 0.3 * periodic_noise(rng, 2) + 0.15 * rng.random((N, N))
    cork = np.where(rng.random((N, N)) < 0.03, cork * 0.5, cork)
    save_texture(out / 'cork.png', colourise(cork, (150, 108, 62), (222, 184, 128)))

    twill = ((XX + YY) % 8 < 3) * 0.35 + 0.45 * periodic_noise(rng, 1.5) + 0.2 * periodic_noise(rng, 10)
    save_texture(out / 'denim.png', colourise(twill, (32, 56, 104), (88, 118, 170)))

    speck = rng.random((N, N))
    granite = np.where(speck < 0.18, 0.1, np.where(speck > 0.85, 0.95, 0.45 + 0.2 * rng.random((N, N))))
    granite = 0.8 * granite + 0.2 * periodic_noise(rng, 6)
    save_texture(out / 'granite.png', colourise(granite, (70, 70, 74), (215, 215, 220)))

    turb = periodic_noise(rng, 14)
    vein = np.abs(np.sin(2 * math.pi * (XX + 2 * YY) / N + 7 * turb))
    marble = 1 - 0.55 * np.exp(-((vein / 0.1) ** 2)) - 0.06 * periodic_noise(rng, 4)
    save_texture(out / 'marble.png', colourise(marble, (120, 120, 126), (246, 246, 248)))

    paper = 0.85 + 0.1 * periodic_noise(rng, 3) + 0.05 * rng.random((N, N))
    save_texture(out / 'paper.png', colourise(paper, (200, 196, 186), (250, 248, 242)))

    parchment = 0.55 + 0.35 * periodic_noise(rng, 18) + 0.1 * periodic_noise(rng, 2)
    save_texture(out / 'parchment.png', colourise(parchment, (214, 186, 120), (246, 230, 186)))

    warp = periodic_noise(rng, 16)
    grain = 0.5 + 0.5 * np.sin(2 * math.pi * 9 * XX / N + 9 * warp)
    wood = 0.65 * grain + 0.25 * periodic_noise(rng, 1) + 0.1 * periodic_noise(rng, 6)
    save_texture(out / 'wood.png', colourise(wood, (110, 66, 32), (196, 140, 86)))


# ── where they go ──────────────────────────────────────────────────────────

# every renderer that has an AI panel keeps its own copy of the buttons
SEND_DIRS = [
    'apps/diagram/src/renderer/ai/assets',
    'apps/docs/src/renderer/assets',
    'apps/epub/src/renderer/ai/assets',
    'apps/html/src/renderer/assets',
    'apps/hwp/src/renderer/assets',
    'apps/markdown/src/renderer/assets',
    'apps/mindmap/src/renderer/ai/assets',
    'apps/pdf/src/renderer/assets',
    'apps/sheets/src/renderer/assets',
    'apps/shell/src/renderer/src/assets',
    'apps/slides/src/renderer/assets',
]
ATTACH_DIRS = [d for d in SEND_DIRS if not d.startswith(('apps/markdown', 'apps/pdf', 'apps/shell'))]


def main():
    for d in SEND_DIRS:
        out = ROOT / d
        send_button(out / 'send-enter-on.png', BLACK, WHITE)
        send_button(out / 'send-enter-off.png', OFF_FILL, GREY)
        stop_button(out / 'send-stop.png')
    for d in ATTACH_DIRS:
        attach_icon(ROOT / d / 'attach-icon.png')
    docs = ROOT / 'apps/docs/src/renderer/assets'
    slides = ROOT / 'apps/slides/src/renderer/assets'
    icon_editor(docs / 'icon-editor.png')
    icon_translate(docs / 'icon-translate.png')
    icon_translate(slides / 'icon-translate.png')
    icon_crop(slides / 'icon-crop.png')
    icon_spelling(slides / 'icon-spelling.png')
    icon_transparency(slides / 'icon-transparency.png')
    textures(slides / 'textures')
    menus = ROOT / 'apps/shell/src/main/assets'
    menu_home(menus / 'menu-home.png', 16)
    menu_home(menus / 'menu-home@2x.png', 32)


if __name__ == '__main__':
    main()
