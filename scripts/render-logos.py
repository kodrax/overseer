#!/usr/bin/env python3
"""Writes docs/assets/logo-{paper,terminal}.svg: the horizontal lockup of design/brand (Surfaces "README header").

Symbol 32 px (24-unit canvas: ring r 10 stroke 2, right half-disc r 6.5), gap 12 px, wordmark "overseer" in
IBM Plex Mono 600 at 32 px with -0.02em letter-spacing. The wordmark is converted to outlines from
design/system/fonts/IBMPlexMono-600.woff2, because GitHub and npm show the SVG through <img>, where web fonts
do not load. Each SVG also gets a 2x PNG (npm cannot show an SVG from raw.githubusercontent.com), rasterized with
headless Chrome (CHROME, default google-chrome). The baseline sits where a 32 px line box with line-height 1 puts it, which centres the symbol on
the x-height as the brand's Construction sheet asks.

    python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools brotli && /tmp/ft/bin/python scripts/render-logos.py
"""
import math
import os
import subprocess
import tempfile
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
THEMES = {  # ink, signal per theme (design/system/tokens.json)
    "paper": ("#1a1916", "#0d7a78"),
    "terminal": ("#ece9e1", "#5cc8bf"),
}
SIZE = 32.0
GAP = 12.0
SYMBOL_TOP = 4.0  # the symbol box sits 4 px below the text box, as in Surfaces.dc.html
WORD = "overseer"

font = TTFont(ROOT / "design/system/fonts/IBMPlexMono-600.woff2")
upm = font["head"].unitsPerEm
scale = SIZE / upm
hhea = font["hhea"]
baseline = (SIZE - (hhea.ascent - hhea.descent) * scale) / 2 + hhea.ascent * scale
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
tracking = -0.02 * SIZE

pen = SVGPathPen(glyphs, ntos=lambda v: f"{v:.2f}".rstrip("0").rstrip("."))
x = SIZE + GAP
for index, char in enumerate(WORD):
    glyph = glyphs[cmap[ord(char)]]
    glyph.draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
    x += glyph.width * scale + (tracking if index < len(WORD) - 1 else 0)
width = round(x, 2)
wordmark = pen.getCommands()

for theme, (ink, signal) in THEMES.items():
    s = SIZE / 24
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{SIZE:g}" viewBox="0 {SYMBOL_TOP:g} {width} {SIZE:g}" '
        f'role="img" aria-label="overseer">'
        f'<g transform="translate(0 {SYMBOL_TOP:g}) scale({s:.6g})">'
        f'<circle cx="12" cy="12" r="10" fill="none" stroke="{ink}" stroke-width="2"/>'
        f'<path d="M12 5.5A6.5 6.5 0 0 1 12 18.5Z" fill="{signal}"/></g>'
        f'<path d="{wordmark}" fill="{ink}"/></svg>\n'
    )
    target = ROOT / f"docs/assets/logo-{theme}.svg"
    target.write_text(svg)
    with tempfile.TemporaryDirectory() as profile:
        subprocess.run(
            [os.environ.get("CHROME", "google-chrome"), "--headless", "--disable-gpu", "--hide-scrollbars",
             f"--user-data-dir={profile}", "--force-device-scale-factor=2", "--default-background-color=00000000",
             f"--window-size={math.ceil(width)},{SIZE:g}", f"--screenshot={target.with_suffix('.png')}", target.as_uri()],
            check=True, capture_output=True, cwd=profile,
        )
    print(f"render-logos: {target.relative_to(ROOT)} and .png ({width} x {SIZE:g})")
