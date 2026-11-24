"""Make neighbouring restyled tiles agree in their shared margin, so roads continue across seams.

Neighbouring tiles each draw the overlap band (2 x MARGIN wide) — the same place, in the same style —
so comparing them is reliable even where comparing to the photo is not. For every pair of
neighbours: measure the relative shift along the band in blocks, then move each tile half-way
towards the other, fully at the shared edge and fading to nothing ~1.5 margins into the tile. Run
after align_tiles.py (absolute alignment), before colour matching and stitching.

Usage: python world3d/seam_align.py <in_dir> <out_dir> [iterations=2]   (from the work dir)
"""
import json
import os
import shutil
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

src, dst = sys.argv[1], sys.argv[2]
iters = int(sys.argv[3]) if len(sys.argv) > 3 else 2
g = json.load(open("tiles_raw/grid.json"))
R, C, M, S = g["R"], g["CORE"], g["MARGIN"], g["SIZE"]
N = 2 * R + 1
BAND = 2 * M            # overlap width
STEP = 128
RAMP = int(1.5 * M) + BAND
os.makedirs(dst, exist_ok=True)

tiles = {(c, r): np.asarray(Image.open(f"{src}/tile_{c}_{r}.png").convert("RGB").resize((S, S), Image.LANCZOS), np.float32)
         for c in range(N) for r in range(N)}


def feat(a):
    gy = ndimage.gaussian_filter(a @ np.array([0.299, 0.587, 0.114], np.float32), 1.2)
    e = np.hypot(ndimage.sobel(gy, 0), ndimage.sobel(gy, 1))
    return np.minimum(e / (ndimage.uniform_filter(e, 25) + 1e-3), 4.0)


def shift(a, b, maxs=48):
    """s such that b(x + s) ≈ a(x), with quality."""
    h, w = a.shape
    win = np.outer(np.hanning(h), np.hanning(w)).astype(np.float32)
    A, B = np.fft.fft2((a - a.mean()) * win), np.fft.fft2((b - b.mean()) * win)
    Rr = A.conj() * B
    r = np.fft.fftshift(np.fft.ifft2(Rr / (np.abs(Rr) + 1e-6)).real)
    cy, cx = h // 2, w // 2
    sub = r[cy - maxs:cy + maxs + 1, cx - maxs:cx + maxs + 1]
    y, x = np.unravel_index(sub.argmax(), sub.shape)
    pk = sub[y, x]
    m = sub.copy()
    m[max(0, y - 5):y + 6, max(0, x - 5):x + 6] = -1
    return x - maxs, y - maxs, pk, pk / max(m.max(), 1e-6)


def band_shifts(fa, fb, horizontal):
    """Relative shifts along the shared band. horizontal: A left of B (band = A's right margin)."""
    n = (S - BAND) // STEP + 1
    out = np.full((n, 2), np.nan, np.float32)
    for k in range(n):
        p = k * STEP
        if horizontal:
            a, b = fa[p:p + BAND, C:C + BAND], fb[p:p + BAND, 0:BAND]
        else:
            a, b = fa[C:C + BAND, p:p + BAND], fb[0:BAND, p:p + BAND]
        if a.std() < 0.05 or b.std() < 0.05:
            continue
        dx, dy, pk, q = shift(a, b)
        if pk > 0.05 and q > 1.3:
            out[k] = dx, dy
    for d in range(2):
        col = out[:, d]
        ok = np.isfinite(col)
        if ok.sum() == 0:
            col[:] = 0
            continue
        med = np.median(col[ok])
        col[ok & (np.abs(col - med) > 12)] = np.nan
        ok = np.isfinite(col)
        col[:] = np.interp(np.arange(len(col)), np.nonzero(ok)[0], col[ok]) if ok.any() else 0
        col[:] = ndimage.gaussian_filter1d(col, 1.0, mode="nearest")
    return out


report = {}
for it in range(iters):
    feats = {k: feat(v) for k, v in tiles.items()}
    disp = {k: np.zeros((S, S, 2), np.float32) for k in tiles}
    total = []
    along = np.arange(S, dtype=np.float32)
    for (c, r) in tiles:
        for horizontal, nb in ((True, (c + 1, r)), (False, (c, r + 1))):
            if nb not in tiles:
                continue
            sh = band_shifts(feats[(c, r)], feats[nb], horizontal)
            centres = np.arange(len(sh)) * STEP + BAND / 2
            sx = np.interp(along, centres, sh[:, 0])
            sy = np.interp(along, centres, sh[:, 1])
            total.append(float(np.hypot(sx, sy).mean()))
            # weight across the band: 1 inside the shared band, fading over RAMP px into each tile
            idx = np.arange(S, dtype=np.float32)
            wa = np.clip(1 - (S - BAND - idx) / (RAMP - BAND), 0, 1)     # A: 1 in its far band, fading inwards
            wb = wa[::-1]                                                  # B: 1 in its near band
            if horizontal:   # band runs vertically: profile across = x, along = y
                disp[(c, r)][..., 0] += -0.5 * sx[:, None] * wa[None, :]
                disp[(c, r)][..., 1] += -0.5 * sy[:, None] * wa[None, :]
                disp[nb][..., 0] += 0.5 * sx[:, None] * wb[None, :]
                disp[nb][..., 1] += 0.5 * sy[:, None] * wb[None, :]
            else:            # band runs horizontally: across = y, along = x
                disp[(c, r)][..., 0] += -0.5 * sx[None, :] * wa[:, None]
                disp[(c, r)][..., 1] += -0.5 * sy[None, :] * wa[:, None]
                disp[nb][..., 0] += 0.5 * sx[None, :] * wb[:, None]
                disp[nb][..., 1] += 0.5 * sy[None, :] * wb[:, None]
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    for k, a in tiles.items():
        d = disp[k]
        out = np.empty_like(a)
        for ch in range(3):
            out[..., ch] = ndimage.map_coordinates(a[..., ch], [yy + d[..., 1], xx + d[..., 0]], order=3, mode="nearest")
        tiles[k] = np.clip(out, 0, 255)
    report[f"iteration {it + 1}"] = {"mean relative shift along seams (px)": round(float(np.mean(total)), 2),
                                     "worst seam": round(float(np.max(total)), 2)}
    print(report[f"iteration {it + 1}"], flush=True)

for (c, r), a in tiles.items():
    Image.fromarray(a.astype(np.uint8)).save(f"{dst}/tile_{c}_{r}.png")
json.dump(report, open(f"{dst}/seam_align_report.json", "w"), indent=1)
if os.path.exists(f"{src}/align_report.json"):
    shutil.copyfile(f"{src}/align_report.json", f"{dst}/align_report.json")
