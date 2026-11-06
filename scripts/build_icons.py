#!/usr/bin/env python3
"""Builds the app icons in assets/icons from the knight in assets/pieces.svg.

Needs macOS (qlmanage renders the SVG) and Pillow. Run it only to change the icon:
the PNG files are committed.
"""
import re
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "icons"
SIZE = 1024
CORNER_RADIUS = 0.2237  # Corner radius of the non-maskable icons, as a share of the side.


def knight_markup() -> str:
    sprite = (ROOT / "assets" / "pieces.svg").read_text()
    match = re.search(r'<g id="wn".*?</g>', sprite, re.S)
    if not match:
        raise SystemExit("White knight not found in pieces.svg")
    return match.group(0)


def source_svg() -> str:
    # The piece is drawn in a 45x45 box. It stays inside the central 80% circle
    # so Android can crop the maskable icon to any shape.
    scale = SIZE * 0.68 / 45
    offset = (SIZE - 45 * scale) / 2
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{SIZE}" height="{SIZE}" viewBox="0 0 {SIZE} {SIZE}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#2997ff"/><stop offset="1" stop-color="#0058c4"/>
  </linearGradient></defs>
  <rect width="{SIZE}" height="{SIZE}" fill="url(#bg)"/>
  <g transform="translate({offset:.2f} {offset:.2f}) scale({scale:.4f})">{knight_markup()}</g>
</svg>"""


def render() -> Image.Image:
    with tempfile.TemporaryDirectory() as tmp:
        svg = Path(tmp) / "icon.svg"
        svg.write_text(source_svg())
        subprocess.run(
            ["qlmanage", "-t", "-s", str(SIZE), "-o", tmp, str(svg)],
            check=True, capture_output=True,
        )
        with Image.open(Path(tmp) / "icon.svg.png") as image:
            return image.convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)


def rounded(image: Image.Image) -> Image.Image:
    mask = Image.new("L", image.size, 0)
    radius = int(image.width * CORNER_RADIUS)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, image.width - 1, image.height - 1), radius, fill=255)
    result = image.convert("RGBA")
    result.putalpha(mask)
    return result


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    full = render()
    full.resize((180, 180), Image.LANCZOS).save(OUT / "apple-touch-icon.png", optimize=True)
    full.resize((512, 512), Image.LANCZOS).save(OUT / "icon-maskable-512.png", optimize=True)
    soft = rounded(full)
    soft.resize((192, 192), Image.LANCZOS).save(OUT / "icon-192.png", optimize=True)
    soft.resize((512, 512), Image.LANCZOS).save(OUT / "icon-512.png", optimize=True)


if __name__ == "__main__":
    main()
