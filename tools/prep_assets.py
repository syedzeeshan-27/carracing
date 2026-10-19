"""One-time asset prep for Road Rush.

Reads the raw generated pictures in assets/ and writes game-ready files to assets/cut/:
  road.jpg                      road texture, re-encoded smaller
  car.png                       player car, green background removed, cropped
  traffic1.png .. traffic5.png  recoloured copies of the car for traffic
  wheel.png gas.png brake.png   split out of controls.png
  info.js                       road edge positions the game reads at load

Usage: python tools/prep_assets.py [--lanes 3] [--swap-pedals] [--rotate-car 0|90|180|270]
"""
import argparse
import json
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets"
OUT = SRC / "cut"
EXTS = (".png", ".jpg", ".jpeg", ".webp")

# Hue shifts (PIL's 0-255 hue scale) for the traffic cars, plus one white car.
TRAFFIC = [("hue", 170), ("hue", 38), ("white", 0), ("hue", 92), ("hue", 198)]


def find(name):
    for ext in EXTS:
        p = SRC / (name + ext)
        if p.exists():
            return p
    return None


def key_green(img):
    """Make the flat green background transparent and pull green spill off the edges."""
    a = np.asarray(img.convert("RGBA")).astype(np.float32)
    if (a[..., 3] < 250).mean() > 0.05:  # already has real transparency
        return Image.fromarray(a.astype(np.uint8), "RGBA")
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    spill = g - np.maximum(r, b)  # how much greener than the other two channels
    alpha = 1 - np.clip((spill - 30) / 60, 0, 1)
    a[..., 1] = np.where(spill > 0, np.maximum(r, b), g)  # despill
    a[..., 3] = alpha * 255
    out = Image.fromarray(a.astype(np.uint8), "RGBA")
    # shave one pixel off the edge so no green fringe survives
    out.putalpha(out.getchannel("A").filter(ImageFilter.MinFilter(3)))
    return out


def crop_to_content(img, pad=4):
    box = img.getchannel("A").point(lambda v: 255 if v > 16 else 0).getbbox()
    if not box:
        return img
    x0, y0, x1, y1 = box
    return img.crop((max(0, x0 - pad), max(0, y0 - pad),
                     min(img.width, x1 + pad), min(img.height, y1 + pad)))


def fit(img, max_side):
    s = max_side / max(img.size)
    if s >= 1:
        return img
    return img.resize((round(img.width * s), round(img.height * s)), Image.LANCZOS)


def components(rgba, keep=3):
    """Bounding boxes of the `keep` biggest separate shapes, left to right."""
    alpha = np.asarray(rgba.getchannel("A"))
    step = max(1, max(alpha.shape) // 400)
    small = Image.fromarray(((alpha[::step, ::step] > 128) * 255).astype(np.uint8))
    small = small.filter(ImageFilter.MaxFilter(5))  # glue pedal pads to their arms
    m = (np.asarray(small) > 0).tolist()
    h, w = len(m), len(m[0])
    seen = [[False] * w for _ in range(h)]
    found = []
    for y in range(h):
        for x in range(w):
            if not m[y][x] or seen[y][x]:
                continue
            seen[y][x] = True
            q = deque([(y, x)])
            n, x0, y0, x1, y1 = 0, x, y, x, y
            while q:
                cy, cx = q.popleft()
                n += 1
                x0, x1, y0, y1 = min(x0, cx), max(x1, cx), min(y0, cy), max(y1, cy)
                for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                    if 0 <= ny < h and 0 <= nx < w and m[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        q.append((ny, nx))
            found.append((n, (x0 * step, y0 * step, (x1 + 1) * step, (y1 + 1) * step)))
    found.sort(reverse=True)
    boxes = [b for _, b in found[:keep]]
    return sorted(boxes, key=lambda b: (b[0] + b[2]) / 2)


def road_edges(img):
    """Left/right edge of the asphalt as fractions of image width."""
    small = img.convert("RGB").resize((400, max(1, round(400 * img.height / img.width))))
    a = np.asarray(small).astype(int)
    mx, mn = a.max(2), a.min(2)
    grey = ((mx - mn) < 28) & (mx > 35) & (mx < 175)
    is_road = (grey.mean(0) > 0.45).tolist()
    runs, start = [], None
    for x, v in enumerate(is_road + [False]):
        if v and start is None:
            start = x
        elif not v and start is not None:
            runs.append([start, x])
            start = None
    merged = []
    for r in runs:  # lane markings make small gaps; close them
        if merged and r[0] - merged[-1][1] <= 6:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    if not merged:
        return None
    best = max(merged, key=lambda r: r[1] - r[0])
    if best[1] - best[0] < 40:
        return None
    return best[0] / 400, best[1] / 400


def recolor(car, mode, shift):
    a = car.getchannel("A")
    hsv = np.asarray(car.convert("RGB").convert("HSV")).astype(np.float32)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    # Paint = pixels near the body's main hue. Tinted glass is just as saturated but a
    # different hue, so matching on hue keeps the windows dark.
    solid = (s > 150) & (v > 120) & (np.asarray(a) > 128)
    paint_hue = np.bincount(h[solid].astype(int), minlength=256).argmax()
    dist = np.abs(h - paint_hue)
    paint = (np.minimum(dist, 256 - dist) < 22) & (s > 60)
    if mode == "hue":
        h = np.where(paint, (h + shift) % 256, h)
    else:
        s = np.where(paint, s * 0.05, s)
        v = np.where(paint, 90 + v * 0.65, v)
    out = Image.fromarray(np.stack([h, s, v], -1).astype(np.uint8), "HSV").convert("RGB")
    out.putalpha(a)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lanes", type=int, default=3)
    ap.add_argument("--swap-pedals", action="store_true")
    ap.add_argument("--rotate-car", type=int, default=0, choices=(0, 90, 180, 270))
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    info = {"road": {"left": 0.31, "right": 0.69, "lanes": args.lanes}}

    p = find("road")
    if p:
        img = Image.open(p).convert("RGB")
        edges = road_edges(img)
        if edges:
            info["road"]["left"], info["road"]["right"] = round(edges[0], 4), round(edges[1], 4)
            print(f"road: asphalt from {edges[0]:.3f} to {edges[1]:.3f} of the width")
        else:
            print("road: could not find the asphalt, using default edges")
        fit(img, 2048).save(OUT / "road.jpg", quality=88)
    else:
        print("road: no assets/road.* found, game will draw a placeholder")

    p = find("car")
    if p:
        car = crop_to_content(key_green(Image.open(p)))
        if args.rotate_car:
            car = car.rotate(-args.rotate_car, expand=True)
        if car.width > car.height:
            print("car: looks sideways, rerun with --rotate-car 90 or 270 so the nose points up")
        car = fit(car, 512)
        car.save(OUT / "car.png")
        for i, (mode, shift) in enumerate(TRAFFIC, 1):
            recolor(car, mode, shift).save(OUT / f"traffic{i}.png")
        print(f"car: {car.width}x{car.height}, plus {len(TRAFFIC)} traffic colours")
    else:
        print("car: no assets/car.* found, game will draw a placeholder")

    p = find("controls")
    if p:
        keyed = key_green(Image.open(p))
        boxes = components(keyed)
        if len(boxes) == 3:
            wheel, brake, gas = boxes
            if args.swap_pedals:
                brake, gas = gas, brake
            for name, box, size in (("wheel", wheel, 600), ("brake", brake, 480), ("gas", gas, 480)):
                fit(crop_to_content(keyed.crop(box)), size).save(OUT / f"{name}.png")
            print("controls: wheel, brake, gas cut out (left to right)")
        else:
            print(f"controls: expected 3 shapes, found {len(boxes)}; game will draw placeholders")
    else:
        print("controls: no assets/controls.* found, game will draw placeholders")

    (OUT / "info.js").write_text("window.ASSET_INFO = " + json.dumps(info) + ";\n")
    print("wrote", OUT / "info.js", json.dumps(info))


if __name__ == "__main__":
    main()
