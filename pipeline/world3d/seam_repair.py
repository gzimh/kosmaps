"""Repair visible seams in a stitched mosaic with the image model.

Alignment (align_tiles.py, seam_align.py) puts neighbouring tiles' content in the same place, but two
independent drawings can still draw the same road or field in a different colour, width or angle,
which shows as a sudden change along the cut. For every window along the tile boundaries where the
two neighbours disagree (scored on the colour-matched tiles' shared margin, weighted up where an OSM
road crosses), a 768 px crop centred on the seam goes to Codex to be redrawn as one continuous
drawing. The result is aligned to the crop and blended back: fully across the seam band, fading to
the original over the outer part of the crop, so nothing far from the seam changes.

Usage (from the work dir):
  python world3d/seam_repair.py score <tiles_dir> <roads.json> [top_n=20]   -> seamfix/windows.json
  python world3d/seam_repair.py run <mosaic.png> <out.png> <prompt.txt> [N=3] [suffix=day]
"""
import json
import math
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

WIN = 768
BAND = 150        # half-height of the fully-replaced band around the seam
RAMP = 200        # then fade to the original over this many px
SIDE = 96         # fade at the window's ends (along the seam)
os.makedirs("seamfix", exist_ok=True)
g = json.load(open("tiles_raw/grid.json"))
R, C, M, S = g["R"], g["CORE"], g["MARGIN"], g["SIZE"]
N = 2 * R + 1
NPX = N * C


def windows():
    """Candidate windows: (orientation, seam coordinate, position along it, tile a, tile b)."""
    out = []
    for k in range(1, N):
        for along in range(WIN // 2 - 64, NPX - WIN // 2 + 64 + 1, 512):
            along = min(max(along, WIN // 2), NPX - WIN // 2)
            out.append(("h", k * C, along))     # horizontal seam between rows k-1 and k
            out.append(("v", k * C, along))     # vertical seam between columns k-1 and k
    return out


def score(tiles_dir, roads_path, top_n):
    rd = json.load(open(roads_path))
    S2 = math.sqrt(0.5)
    mpp = rd["mpp"]
    road = Image.new("L", (NPX, NPX), 0)
    d = ImageDraw.Draw(road)
    for l in rd["links"]:
        pts = [(NPX / 2 + (S2 * e - S2 * n) / mpp, NPX / 2 - (0.5 * e + 0.5 * n + S2 * h) / mpp) for e, n, h in (rd["nodes"][i] for i in l["pts"])]
        d.line(pts, fill=255, width=12)
    road = np.asarray(road) > 0
    tiles = {(c, r): np.asarray(Image.open(f"{tiles_dir}/tile_{c}_{r}.png").convert("RGB").resize((S, S), Image.LANCZOS), np.float32)
             for c in range(N) for r in range(N)}
    blur = {k: ndimage.gaussian_filter(v, (3, 3, 0)) for k, v in tiles.items()}
    res = []
    for o, pos, along in windows():
        k = pos // C
        a0, a1 = along - WIN // 2, along + WIN // 2
        diffs, roadhit = [], 0
        for col_or_row in range(N):
            # pieces of the window covered by this tile pair (tile index along the seam)
            lo, hi = max(a0, col_or_row * C), min(a1, (col_or_row + 1) * C)
            if lo >= hi:
                continue
            if o == "h":
                A, B = blur[(col_or_row, k - 1)], blur[(col_or_row, k)]
                xs = slice(lo - col_or_row * C + M, hi - col_or_row * C + M)
                da = A[C:C + 2 * M, xs] - B[0:2 * M, xs]
                roadhit += int(road[pos - M:pos + M, lo:hi].sum())
            else:
                A, B = blur[(k - 1, col_or_row)], blur[(k, col_or_row)]
                ys = slice(lo - col_or_row * C + M, hi - col_or_row * C + M)
                da = A[ys, C:C + 2 * M] - B[ys, 0:2 * M]
                roadhit += int(road[lo:hi, pos - M:pos + M].sum())
            diffs.append(np.abs(da).mean())
        s = float(np.mean(diffs)) * (1.6 if roadhit > 300 else 1.0)
        res.append({"o": o, "pos": pos, "along": along, "score": round(s, 2), "road": roadhit > 300})
    res.sort(key=lambda r: -r["score"])
    keep = []
    for r in res:   # drop windows overlapping an already-chosen one on the same seam
        if any(k["o"] == r["o"] and k["pos"] == r["pos"] and abs(k["along"] - r["along"]) < 600 for k in keep):
            continue
        keep.append(r)
        if len(keep) >= top_n:
            break
    json.dump(keep, open("seamfix/windows.json", "w"), indent=1)
    for r in keep:
        print(r)


def box(w):
    if w["o"] == "h":
        return w["along"] - WIN // 2, w["pos"] - WIN // 2
    return w["pos"] - WIN // 2, w["along"] - WIN // 2


def weight(w):
    across = np.abs(np.arange(WIN) - WIN / 2)
    wa = np.clip(1 - (across - BAND) / RAMP, 0, 1)
    wa = wa * wa * (3 - 2 * wa)
    along = np.minimum(np.arange(WIN), WIN - 1 - np.arange(WIN))
    wl = np.clip(along / SIDE, 0, 1)
    wl = wl * wl * (3 - 2 * wl)
    return (wa[:, None] * wl[None, :]) if w["o"] == "h" else (wl[:, None] * wa[None, :])


def align(a, b):
    """Shift (dx, dy) to apply to b so it matches a, from edges near the window's outer parts."""
    def e(x):
        gy = ndimage.gaussian_filter(x @ np.array([0.299, 0.587, 0.114], np.float32), 1.5)
        return np.hypot(ndimage.sobel(gy, 0), ndimage.sobel(gy, 1))
    A, B = e(a), e(b)
    hw = np.outer(np.hanning(WIN), np.hanning(WIN))
    F = np.fft.fft2((A - A.mean()) * hw).conj() * np.fft.fft2((B - B.mean()) * hw)
    r = np.fft.fftshift(np.fft.ifft2(F / (np.abs(F) + 1e-6)).real)
    c = WIN // 2
    sub = r[c - 24:c + 25, c - 24:c + 25]
    y, x = np.unravel_index(sub.argmax(), sub.shape)
    return x - 24, y - 24


def run(mosaic_path, out_path, prompt_path, n_par, suffix):
    wins = json.load(open("seamfix/windows.json"))
    mos = Image.open(mosaic_path).convert("RGB")
    prompt = open(prompt_path).read()
    work = os.path.abspath("seamfix")

    def gen(i_w):
        i, w = i_w
        x0, y0 = box(w)
        src = f"{work}/{suffix}_{i:02d}_in.png"
        dst = f"{work}/{suffix}_{i:02d}_out.png"
        if os.path.exists(dst) and os.path.getsize(dst) > 0:
            return i, "skip"
        mos.crop((x0, y0, x0 + WIN, y0 + WIN)).save(src)
        p = (prompt.replace("OUTPUT_PATH", dst)
             .replace("SEAM_LINE", "horizontal line" if w["o"] == "h" else "vertical line")
             .replace("SEAM_SIDE", "TOP half's" if w["o"] == "h" else "LEFT half's"))
        with open(f"{work}/{suffix}_{i:02d}.log", "w") as log:
            subprocess.run(["codex", "exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", work, "-i", src,
                            "-o", f"{work}/{suffix}_{i:02d}.last", "-"], input=p, text=True, stdout=log, stderr=log)
        return i, "done" if os.path.exists(dst) else "FAILED"

    with ThreadPoolExecutor(n_par) as ex:
        for i, st in ex.map(gen, list(enumerate(wins))):
            print(f"window {i} ({wins[i]['o']} seam at {wins[i]['pos']}, {wins[i]['along']}): {st}", flush=True)

    arr = np.asarray(mos, np.float32).copy()
    yy, xx = np.mgrid[0:WIN, 0:WIN].astype(np.float32)
    for i, w in enumerate(wins):
        dst = f"seamfix/{suffix}_{i:02d}_out.png"
        if not os.path.exists(dst):
            continue
        x0, y0 = box(w)
        orig = arr[y0:y0 + WIN, x0:x0 + WIN]
        new = np.asarray(Image.open(dst).convert("RGB").resize((WIN, WIN), Image.LANCZOS), np.float32)
        dx, dy = align(orig, new)
        if abs(dx) > 20 or abs(dy) > 20:
            print(f"  window {i}: redraw moved {dx},{dy} px — skipped")
            continue
        new = np.stack([ndimage.map_coordinates(new[..., ch], [yy + dy, xx + dx], order=1, mode="nearest") for ch in range(3)], -1)
        # keep the original's overall colour: match per-channel mean/std over the blend area
        wgt = weight(w)[..., None]
        m = wgt[..., 0] > 0.05
        for ch in range(3):
            a, b = orig[..., ch][m], new[..., ch][m]
            new[..., ch] = (new[..., ch] - b.mean()) / (b.std() + 1e-3) * a.std() + a.mean()
        arr[y0:y0 + WIN, x0:x0 + WIN] = orig * (1 - wgt) + new * wgt
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save(out_path)
    print("saved", out_path)


if __name__ == "__main__":
    if sys.argv[1] == "score":
        score(sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 20)
    else:
        run(sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]) if len(sys.argv) > 5 else 3,
            sys.argv[6] if len(sys.argv) > 6 else "day")
