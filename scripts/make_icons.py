#!/usr/bin/env python3
"""
Cuts the whole icon set from assets/icon-source.png.

    python3 scripts/make_icons.py

The source is a finished app-store render: the padlock sits inside a baked dark
squircle, which sits in turn on a black margin. Every platform applies a mask of
its own, so both have to go before the art is any use as an icon — otherwise iOS
rounds an already-rounded tile and the result floats inside black corners.

Nothing here is measured by hand. The tile and the padlock are found by
thresholding luminance, which is what separates them: the margin is black, the
tile is very dark, and the padlock is bright. Replace icon-source.png with a new
render and re-run; the numbers below are ratios and thresholds, not coordinates.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ASSETS = Path(__file__).resolve().parent.parent / "assets"
SOURCE = ASSETS / "icon-source.png"

# The field behind everything, matching the app's own background so the adaptive
# icon's background layer, the splash and the artwork all agree.
FIELD = (14, 16, 20)  # #0E1014

TILE_THRESHOLD = 8
GLYPH_THRESHOLD = 60

# An adaptive icon is 108dp, of which the launcher shows about 72dp and only the
# central 66dp is guaranteed to survive whichever mask it picks — a circle on
# some, a squircle on others. The glyph is sized to that circle rather than to
# the 72dp usually shown, which is why it looks smaller than the iOS icon.
ADAPTIVE_SIZE = 1024
SAFE_ZONE_FRACTION = 66 / 108

# Alpha for the glyph comes from luminance. The artwork is bright, the tile under
# it is not, and the result is composited back over that same dark field, so a
# soft ramp reproduces the original — including the lock's glow and shadow —
# rather than cutting a hard edge through it.
ALPHA_FLOOR = 22
ALPHA_CEILING = 55

# How much of the splash canvas the glyph fills. The plugin's imageWidth decides
# the rendered size; this only decides how much air the PNG carries around it.
SPLASH_FILL = 0.82


def measured_bbox(luminance: Image.Image, threshold: int) -> tuple[int, int, int, int]:
    """Bounding box of everything above `threshold`, with single-pixel noise eroded."""
    mask = luminance.point(lambda v: 255 if v > threshold else 0)
    return mask.filter(ImageFilter.MinFilter(3)).getbbox()


def square_about(box, bounds):
    """The largest square inside `box`, centred on it and clipped to `bounds`."""
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    side = min(box[2] - box[0], box[3] - box[1])
    left, top = max(0, round(cx - side / 2)), max(0, round(cy - side / 2))
    return (left, top, min(bounds[0], left + side), min(bounds[1], top + side))


def fill_corners(tile: Image.Image, fill) -> Image.Image:
    """
    Replace the black left outside the baked rounding.

    Flooding in from the corners rather than keying on colour, because the lock's
    shadow and the ring's centre are near-black too and are meant to stay that
    way. The threshold sits well under the distance from black to the tile's
    darkest edge, so the fill stops where the tile starts.
    """
    filled = tile.copy()
    w, h = filled.size
    for corner in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        ImageDraw.floodfill(filled, corner, fill, thresh=14)
    return filled


def glyph_layer(source: Image.Image, luminance: Image.Image, box) -> Image.Image:
    """The padlock alone, on transparency, cropped to itself."""
    span = ALPHA_CEILING - ALPHA_FLOOR
    alpha = luminance.point(
        lambda v: 0 if v <= ALPHA_FLOOR
        else 255 if v >= ALPHA_CEILING
        else round(255 * (v - ALPHA_FLOOR) / span)
    )
    layer = source.convert("RGBA")
    layer.putalpha(alpha)
    return layer.crop(box)


def enclosing_radius(layer: Image.Image) -> float:
    """Centre to the furthest pixel that is not transparent — what a round mask cuts."""
    alpha = layer.getchannel("A")
    w, h = alpha.size
    cx, cy = (w - 1) / 2, (h - 1) / 2
    px = alpha.load()
    return max(
        (math.hypot(x - cx, y - cy) for y in range(h) for x in range(w) if px[x, y] > 8),
        default=1.0,
    )


def place(layer: Image.Image, canvas_size: int, radius_budget: float) -> Image.Image:
    """Centre `layer` on a transparent square, scaled so it fits inside a circle."""
    scale = radius_budget / enclosing_radius(layer)
    size = (max(1, round(layer.width * scale)), max(1, round(layer.height * scale)))
    scaled = layer.resize(size, Image.LANCZOS)
    canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    canvas.paste(scaled, ((canvas_size - size[0]) // 2, (canvas_size - size[1]) // 2))
    return canvas


def save(image: Image.Image, name: str) -> None:
    path = ASSETS / name
    image.save(path, optimize=True)
    art = image.getchannel("A").getbbox() if image.mode == "RGBA" else None
    extent = f", art {art[2] - art[0]}x{art[3] - art[1]}" if art else ""
    print(f"  {name:<32} {image.size[0]}x{image.size[1]} {image.mode}{extent}")


def main() -> None:
    source = Image.open(SOURCE).convert("RGB")
    luminance = source.convert("L")

    tile_box = measured_bbox(luminance, TILE_THRESHOLD)
    glyph_box = measured_bbox(luminance, GLYPH_THRESHOLD)
    print(f"source {source.size[0]}x{source.size[1]}, tile {tile_box}, glyph {glyph_box}")

    # The tile, full bleed. No alpha: iOS discards it and leaves black behind.
    crop = square_about(tile_box, source.size)
    icon = fill_corners(source.crop(crop), FIELD).resize((1024, 1024), Image.LANCZOS)
    save(icon, "icon.png")
    save(icon.resize((48, 48), Image.LANCZOS), "favicon.png")

    glyph = glyph_layer(source, luminance, glyph_box)

    foreground = place(glyph, ADAPTIVE_SIZE, ADAPTIVE_SIZE * SAFE_ZONE_FRACTION / 2)
    save(foreground, "android-icon-foreground.png")

    # The themed-icon layer: the same silhouette, for the launcher to tint.
    monochrome = Image.new("RGBA", foreground.size, (255, 255, 255, 0))
    monochrome.putalpha(foreground.getchannel("A"))
    save(monochrome, "android-icon-monochrome.png")

    save(place(glyph, 1024, 1024 * SPLASH_FILL / 2), "splash-icon.png")


if __name__ == "__main__":
    main()
