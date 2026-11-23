"""Measure how far each OSM footprint is shifted from the Google 3D surface (top-down DSM)."""
import json
import numpy as np
from PIL import Image, ImageDraw

RES, EXT = 0.5, 700
dsm = np.load("dsm.npy")
B = json.load(open("buildings.json"))["buildings"]
G = dsm.shape[0]


def mask_for(fp, de, dn, pad):
    es = [p[0] + de for p in fp]; ns = [p[1] + dn for p in fp]
    i0 = int((min(es) - pad + EXT) / RES); i1 = int((max(es) + pad + EXT) / RES) + 1
    j0 = int((EXT - (max(ns) + pad)) / RES); j1 = int((EXT - (min(ns) - pad)) / RES) + 1
    im = Image.new("L", (i1 - i0, j1 - j0), 0)
    ImageDraw.Draw(im).polygon([((e + EXT) / RES - i0, (EXT - n) / RES - j0) for e, n in zip(es, ns)], fill=1)
    return np.asarray(im, bool), (j0, j1, i0, i1)


def score(b, de, dn):
    m, (j0, j1, i0, i1) = mask_for(b["fp"], de, dn, 0)
    if j0 < 0 or i0 < 0 or j1 > G or i1 > G:
        return np.nan
    win = dsm[j0:j1, i0:i1]
    elev = win > b["ground"] + 0.6 * (b["roof_main"] - b["ground"])  # roof-level surfaces
    seen = np.isfinite(win)
    inside = m & seen
    if inside.sum() < 30:
        return np.nan
    # reward roof cells inside the footprint, penalise visible ground inside it
    return elev[inside].mean() - 0.5 * (~elev[inside]).mean()


shifts = np.arange(-8, 8.01, 0.5)
res = []
for b in B:
    if b["roof_main"] - b["ground"] < 5:
        continue
    best = (-9, 0, 0)
    s0 = score(b, 0, 0)
    for de in shifts:
        for dn in shifts:
            s = score(b, de, dn)
            if np.isfinite(s) and s > best[0]:
                best = (s, de, dn)
    if np.isfinite(s0):
        res.append((b["id"], best[1], best[2], s0, best[0]))
r = np.array(res)
print(f"buildings fitted: {len(r)}")
print(f"median shift: east {np.median(r[:,1]):+.1f} m, north {np.median(r[:,2]):+.1f} m")
print(f"IQR east {np.percentile(r[:,1],25):+.1f}..{np.percentile(r[:,1],75):+.1f}  north {np.percentile(r[:,2],25):+.1f}..{np.percentile(r[:,2],75):+.1f}")
print(f"mean score before {r[:,3].mean():.2f} -> after per-building fit {r[:,4].mean():.2f}")
for row in r[np.isin(r[:,0], [47, 28, 200])]:
    print("id %d: shift e%+.1f n%+.1f score %.2f -> %.2f" % tuple(row))
json.dump({int(row[0]): [float(row[1]), float(row[2])] for row in r}, open("osm_shifts.json", "w"))
