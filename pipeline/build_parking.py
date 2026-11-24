"""Parked cars as 3D objects, found where the city really had them.

The illustration is drawn with no vehicles (every car is a live 3D object). Parked cars are found
on a 0.25 m ground grid; a cell is "car" only when four independent signals agree:
  1. the 3D capture stands a low, car-height bump over the ground there (0.35-2.6 m: Google's
     photogrammetry smooths parked cars into low bumps);
  2. it isn't part of a building (idmap);
  3. the car-free illustration shows pavement there, not grass or trees (rules out hedges);
  4. an earlier restyle that still drew cars has something different there (a drawn car).
(A strongly drawn car on low pavement also counts without a 3D bump: some parked cars are too
smooth in the capture to read.)
Connected patches become cars: a single car, a row side by side (cars across the row) or a line
nose to tail (cars along it). Patches on a driving lane were moving traffic and are dropped. Each
car takes its paint colour from the restyle that drew it.

Then the detections are laid out like a tidy town (see `orderly()`): cars are grouped into rows
(side by side in bays, or nose to tail along a kerb), each row is squared to the nearest street,
cars share one heading per row (nose-in, or with the traffic at a kerb), and they are snapped onto
the parking-bay stripes painted in the illustration (pitch and phase measured per row). Single
empty bays inside a row are filled.

Car parks are then laid out from the drawing itself (see `layout_lots()`): each OSM car park is
rectified onto the ground plane, the painted bay stripes are found there (direction, pitch, and
the band of every row), and the bays are filled the way a busy town looks (~80%, detected cars
keep their colour). Outside car parks only tidy kerbside rows of detected cars are kept.

Usage (from pipeline/): python build_parking.py <mosaic_with_cars.png> <mosaic_without_cars.png>
Inputs: tiles_raw/grid.json, height_mosaic.npy, idmap.png, roads.json, parking_osm.json
  (Overpass, out geom: way["amenity"="parking"] in the map's bbox), mosaic_without_cars_2x.png if present
Output: parked_cars.json  {"cars": [[east, north, ground height, heading, "#rrggbb"], ...]}
"""
import json
import math
import sys

import random

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage
from shapely.geometry import Point, Polygon
from shapely.prepared import prep

CELL = 0.25
CAR_L, CAR_W = 4.4, 1.8
ROW_PITCH = 2.5                  # side-by-side spacing in a row of parked cars
LINE_PITCH = 5.6                 # nose-to-tail spacing along a kerb
LANE_M = 2.6                     # a patch centred this close to a street's lane centre line was moving traffic
SERVICE_LANE_M = 1.0             # service roads (car park aisles, yards) are lined by parked cars
DIFF_T = 34

with_cars = np.asarray(Image.open(sys.argv[1]).convert("RGB").filter(ImageFilter.GaussianBlur(1)), np.int16)
without_np = np.asarray(Image.open(sys.argv[2]).convert("RGB").filter(ImageFilter.GaussianBlur(1)), np.int16)
paint_src = np.asarray(Image.open(sys.argv[1]).convert("RGB"))
g = json.load(open("tiles_raw/grid.json"))
NPX = (2 * g["R"] + 1) * g["CORE"]
MPP = g["M_PER_PX"]
X0 = Y0 = NPX / 2
S2 = math.sqrt(0.5)
H = np.load("height_mosaic.npy")
idm = np.asarray(Image.open("idmap.png").convert("RGB")).astype(np.int32)
building = (idm[..., 0] + 256 * idm[..., 1]) > 0

# ------------------------------------------------------------------ ground model (low percentile per 10 m cell)
Ys, Xs = np.mgrid[0:NPX, 0:NPX]
xg = (Xs + 0.5 - X0) * MPP
yg = (Y0 - (Ys + 0.5)) * MPP
valid = np.isfinite(H)
E = (xg / S2 + 2 * (yg - S2 * H)) / 2
N = (2 * (yg - S2 * H) - xg / S2) / 2
EXT, DC = 1000, 10
GC = 2 * EXT // DC
gi = ((np.nan_to_num(E[valid]) + EXT) // DC).astype(np.int64)
gj = ((EXT - np.nan_to_num(N[valid])) // DC).astype(np.int64)
key = gj * GC + gi
order = np.argsort(key, kind="stable")
ks, hk = key[order], H[valid][order]
uk, st = np.unique(ks, return_index=True)
dem = np.full(GC * GC, np.nan, np.float32)
for k, s0, s1 in zip(uk, st, list(st[1:]) + [len(ks)]):
    if s1 - s0 > 15:
        dem[k] = np.percentile(hk[s0:s1], 5)
dem = dem.reshape(GC, GC)
with np.errstate(all="ignore"):
    import warnings
    warnings.simplefilter("ignore", RuntimeWarning)
    dem = ndimage.generic_filter(dem, np.nanmedian, size=3, mode="nearest")

# ------------------------------------------------------------------ ground grid over the drawn map
ge = np.arange(-650, 650, CELL)
gn = np.arange(650, -650, -CELL)
EE, NN = np.meshgrid(ge, gn)
di = np.clip(((EE + EXT) // DC).astype(np.int64), 0, GC - 1)
dj = np.clip(((EXT - NN) // DC).astype(np.int64), 0, GC - 1)
G0 = dem[dj, di]
G0z = np.nan_to_num(G0)


_a, _f = 6378137.0, 1 / 298.257223563
_e2 = _f * (2 - _f)
_phi = math.radians(g["lat"])
KX = math.radians(1) * _a / math.sqrt(1 - _e2 * math.sin(_phi) ** 2) * math.cos(_phi)
KY = math.radians(1) * _a * (1 - _e2) / (1 - _e2 * math.sin(_phi) ** 2) ** 1.5


def ll2en(lat, lon):
    return ((lon - g["lon"]) * KX, (lat - g["lat"]) * KY)


def proj(e, n, h):
    return X0 + (S2 * e - S2 * n) / MPP, Y0 - (0.5 * e + 0.5 * n + S2 * h) / MPP


def sample(arr, X, Y, fill):
    xi, yi = X.astype(np.int64), Y.astype(np.int64)
    ok = (xi >= 0) & (yi >= 0) & (xi < NPX) & (yi < NPX) & np.isfinite(G0)
    out = np.full(X.shape + arr.shape[2:], fill, dtype=arr.dtype)
    out[ok] = arr[yi[ok], xi[ok]]
    return out, ok


# 1. low bump: the line of sight just above the ground is blocked by something car-high
Xb, Yb = proj(EE, NN, G0z + 0.3)
surf, ok = sample(np.nan_to_num(H, nan=-999).astype(np.float32), Xb, Yb, -999)
bump = surf - G0z
c1 = ok & (bump >= 0.35) & (bump <= 2.6)
# 2. not a building (where the car's roof would be drawn)
Xr, Yr = proj(EE, NN, G0z + 1.2)
bld, _ = sample(building, Xr, Yr, True)
c2 = ~bld
# 3. paved in the car-free drawing (not green)
Xg, Yg = proj(EE, NN, G0z)
pav, _ = sample(without_np, Xg, Yg, 0)
r_, g_, b_ = (pav[..., i].astype(int) for i in range(3))
c3 = ~((g_ > r_ + 8) & (g_ > b_ + 12))
# 4. the restyle with cars drew something here
Xc, Yc = proj(EE, NN, G0z + 0.7)
a1, _ = sample(with_cars, Xc, Yc, 0)
a2, _ = sample(without_np, Xc, Yc, 0)
d4 = np.abs(a1 - a2).max(-1)
c4 = d4 > DIFF_T
# a strongly drawn car on pavement counts even where the 3D bump is too smooth to read, as long as
# nothing taller than a car stands there (that would be a tree or an awning)
low = ok & (bump <= 2.6)
mask = ((c1 & c4) | (low & (d4 > 70))) & c2 & c3
mask = ndimage.binary_opening(mask, iterations=2)
mask = ndimage.binary_closing(mask, iterations=2)
print(f"car cells: bump {c1.mean():.3f}, not building {c2.mean():.3f}, paved {c3.mean():.3f}, drawn {c4.mean():.3f} -> all four {mask.mean():.4f}")

# ------------------------------------------------------------------ lanes (moving traffic test)
roads = json.load(open("roads.json"))
RN = roads["nodes"]
segs, seg_tol = [], []
for l in roads["links"]:
    tol = SERVICE_LANE_M if l["cls"] == "service" else LANE_M
    off = 0.0 if l["oneway"] else 1.55
    for a, b in zip(l["pts"], l["pts"][1:]):
        (e1, n1, _), (e2, n2, _) = RN[a], RN[b]
        L = math.hypot(e2 - e1, n2 - n1) or 1
        nx, ny = (n2 - n1) / L, -(e2 - e1) / L
        for side in ([0.0] if off == 0 else [off, -off]):
            segs.append((e1 + nx * side, n1 + ny * side, e2 + nx * side, n2 + ny * side))
            seg_tol.append(tol)
segs, seg_tol = np.array(segs), np.array(seg_tol)


def on_lane(e, n):
    """Is (e, n) on a driving lane (within that road class's tolerance of its centre line)?"""
    x1, y1, x2, y2 = segs.T
    dx, dy = x2 - x1, y2 - y1
    t = np.clip(((e - x1) * dx + (n - y1) * dy) / np.maximum(dx * dx + dy * dy, 1e-9), 0, 1)
    return bool(np.any(np.hypot(e - x1 - dx * t, n - y1 - dy * t) < seg_tol))


def greenish(rgb):
    r, g_, b = (int(v) for v in rgb)
    return g_ > r + 6 and g_ > b + 10


def on_greenery(e, n, h, heading):
    """Is the car's footprint mostly vegetation in the car-free drawing (a tree, not a car)?"""
    c, s_ = math.cos(heading), math.sin(heading)
    hits = 0
    for a in (-1.6, 0.0, 1.6):
        for b in (-0.6, 0.6):
            X, Y = proj(e + c * a - s_ * b, n + s_ * a + c * b, h + 0.7)
            xi, yi = int(X), int(Y)
            if 0 <= xi < NPX and 0 <= yi < NPX and greenish(without_np[yi, xi]):
                hits += 1
    return hits >= 3


def paint(e, n, h):
    X, Y = proj(e, n, h + 1.3)
    xi, yi = int(X), int(Y)
    if not (3 <= xi < NPX - 3 and 3 <= yi < NPX - 3):
        return None
    p = paint_src[yi - 2:yi + 3, xi - 2:xi + 3].reshape(-1, 3).astype(float)
    lum = p @ [0.299, 0.587, 0.114]
    keep = p[lum > np.percentile(lum, 30)]
    return "#%02x%02x%02x" % tuple(int(v) for v in np.median(keep if len(keep) else p, axis=0))


# ------------------------------------------------------------------ orderly layout
lum_img = np.asarray(Image.open(sys.argv[2]).convert("L"), np.float32)   # car-free drawing (bay stripes)
seg_dir = np.arctan2(segs[:, 3] - segs[:, 1], segs[:, 2] - segs[:, 0])


def nearest_lane(e, n):
    """(distance, travel direction) of the nearest lane centre line."""
    x1, y1, x2, y2 = segs.T
    dx, dy = x2 - x1, y2 - y1
    t = np.clip(((e - x1) * dx + (n - y1) * dy) / np.maximum(dx * dx + dy * dy, 1e-9), 0, 1)
    d = np.hypot(e - x1 - dx * t, n - y1 - dy * t)
    i = int(np.argmin(d))
    return float(d[i]), float(seg_dir[i]), (float(x1[i] + dx[i] * t[i]), float(y1[i] + dy[i] * t[i]))


def wrap(a, period=math.pi):
    return (a + period / 2) % period - period / 2


def snap_axis(angle, e, n):
    """Square an angle (mod pi) to the nearest street's direction or its perpendicular, if close."""
    _, d, _ = nearest_lane(e, n)
    best = angle
    for ref in (d, d + math.pi / 2):
        if abs(wrap(angle - ref)) < math.radians(20):
            best = angle - wrap(angle - ref)
    return best


def lum_at(e, n, h):
    X, Y = proj(e, n, h)
    xi, yi = int(X), int(Y)
    if 0 <= xi < NPX and 0 <= yi < NPX:
        return float(lum_img[yi, xi])
    return None


def bay_lattice(origin, u, h, lo, hi, default_pitch):
    """Pitch and phase of painted bay stripes along a row: stripes are bright on darker asphalt."""
    xs = np.arange(lo - 3.0, hi + 3.0, 0.05)
    prof = np.array([lum_at(origin[0] + u[0] * x, origin[1] + u[1] * x, h) or np.nan for x in xs])
    ok = np.isfinite(prof)
    if ok.sum() < 40:
        return default_pitch, None
    prof = np.where(ok, prof, np.nanmedian(prof))
    prof = prof - ndimage.uniform_filter1d(prof, 40)          # remove slow shading, keep stripes
    best = (0.0, default_pitch, None)
    for pitch in np.arange(2.3, 3.05, 0.05):
        for phase in np.arange(0, pitch, 0.05):
            k = np.round((xs - phase) / pitch)
            on = np.abs(xs - phase - k * pitch) < 0.08
            if on.sum() < 3:
                continue
            score = prof[on].mean() - prof[~on].mean()
            if score > best[0]:
                best = (score, pitch, phase)
    return (best[1], best[2]) if best[0] > 6 else (default_pitch, None)


def orderly(raw):
    """Group detections into rows and lay each row out on a regular, street-squared lattice."""
    pts = [(c[0], c[1], c[2], c[3], c[4]) for c in raw]
    n_ = len(pts)
    # snap every car's heading to its street grid first
    heads = [snap_axis(p[3], p[0], p[1]) for p in pts]
    parent = list(range(n_))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(n_):
        for j in range(i + 1, n_):
            de, dn = pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]
            dist = math.hypot(de, dn)
            if dist > 7.5 or abs(wrap(heads[i] - heads[j])) > math.radians(18):
                continue
            # side by side (link perpendicular to heading) or nose to tail (link along heading)
            along = abs(math.cos(math.atan2(dn, de) - heads[i]))
            if (along < 0.35 and dist < 4.0) or (along > 0.9 and dist < 7.5):
                parent[find(i)] = find(j)
    rows = {}
    for i in range(n_):
        rows.setdefault(find(i), []).append(i)

    out = []
    for members in rows.values():
        P = np.array([[pts[i][0], pts[i][1]] for i in members])
        hd = heads[members[0]]
        if len(members) == 1:
            # a lone car only stays if it's parked along a kerb, parallel to the traffic
            d_lane, lane_dir, _ = nearest_lane(P[0, 0], P[0, 1])
            if not (d_lane < 5.0 and abs(math.cos(hd - lane_dir)) > 0.95):
                continue
        c = P.mean(0)
        dvec = np.array([math.cos(hd), math.sin(hd)])
        nvec = np.array([-dvec[1], dvec[0]])
        spread_d = np.ptp(P @ dvec) if len(P) > 1 else 0
        spread_n = np.ptp(P @ nvec) if len(P) > 1 else 0
        side_by_side = len(P) == 1 or spread_n >= spread_d
        u = nvec if side_by_side else dvec                   # row direction
        h = float(np.median([pts[i][2] for i in members]))
        default_pitch = ROW_PITCH if side_by_side else LINE_PITCH
        along = (P - c) @ u
        lo, hi = along.min(), along.max()
        pitch, phase = (bay_lattice(c, u, h + 0.02, lo, hi, default_pitch) if side_by_side and len(P) >= 2
                        else (default_pitch, None))
        if phase is None:
            # no stripes found: start the lattice at the first car
            phase = lo - pitch / 2
        # slots: bay centres sit half a pitch past each stripe
        k_lo = math.floor((lo - phase) / pitch - 0.5)
        k_hi = math.ceil((hi - phase) / pitch - 0.5)
        slots = {k: phase + (k + 0.5) * pitch for k in range(k_lo, k_hi + 1)}
        taken = {}
        for i, a in zip(members, along):
            k = min(slots, key=lambda kk: abs(slots[kk] - a))
            if abs(slots[k] - a) < pitch * 0.75 and k not in taken:
                taken[k] = i
        # fill single empty bays inside the row (a row reads as a row)
        ks = sorted(taken)
        for a_, b_ in zip(ks, ks[1:]):
            if b_ - a_ == 2:
                taken[a_ + 1] = taken[a_]
        # one heading for the whole row
        if side_by_side:
            # nose in: front points away from the nearest driving lane (the aisle / street)
            _, _, foot = nearest_lane(*c)
            away = np.array([c[0] - foot[0], c[1] - foot[1]])
            heading = hd if np.dot(away, dvec) >= 0 else hd + math.pi
        else:
            # kerbside: same direction as the traffic in the nearest lane
            _, lane_dir, _ = nearest_lane(*c)
            heading = hd if math.cos(hd - lane_dir) >= 0 else hd + math.pi
        # the row's line: median offset across the row
        off = float(np.median((P - c) @ (dvec if side_by_side else nvec)))
        base = c + (dvec if side_by_side else nvec) * off
        for k, i in sorted(taken.items()):
            e, nn = base + u * slots[k]
            if on_lane(e, nn):
                continue
            out.append([round(float(e), 2), round(float(nn), 2), round(h, 2), round(wrap(heading, 2 * math.pi), 3), pts[i][4]])
    return out


# ------------------------------------------------------------------ car parks: bays read from the drawing
PALETTE = [("#f1efea", 24), ("#c9ccd1", 20), ("#8e939a", 15), ("#2e3136", 15), ("#3e5a7e", 7),
           ("#a33f3d", 6), ("#e9dcc0", 4), ("#5d6e92", 5), ("#6f7f5a", 2), ("#d8b16e", 2)]
rng = random.Random(11)
OCCUPANCY = 0.8
RES = 0.1                                       # rectified ground image resolution (m)
_hi_path = sys.argv[2].replace(".png", "_2x.png")
try:
    hi_img = np.asarray(Image.open(_hi_path).convert("L"), np.float32)
    HI_F = hi_img.shape[0] / NPX
except FileNotFoundError:
    hi_img, HI_F = lum_img, 1.0


def palette_colour():
    r = rng.random() * sum(w for _, w in PALETTE)
    for c_, w in PALETTE:
        r -= w
        if r <= 0:
            return c_
    return PALETTE[0][0]


def ground_h(e, n):
    i = np.clip(((e + EXT) // DC).astype(np.int64), 0, GC - 1)
    j = np.clip(((EXT - n) // DC).astype(np.int64), 0, GC - 1)
    return np.nan_to_num(dem[j, i])


def rectify(origin, u, v, ulen, vlen):
    """Drawing luminance resampled onto a ground grid (rows = v, cols = u), NaN off the map."""
    us = np.arange(0, ulen, RES)
    vs = np.arange(0, vlen, RES)
    UU, VV = np.meshgrid(us, vs)
    E_ = origin[0] + u[0] * UU + v[0] * VV
    N_ = origin[1] + u[1] * UU + v[1] * VV
    X, Y = proj(E_, N_, ground_h(E_, N_))
    xi, yi = (X * HI_F).astype(np.int64), (Y * HI_F).astype(np.int64)
    ok = (xi >= 0) & (yi >= 0) & (xi < hi_img.shape[1]) & (yi < hi_img.shape[0])
    img = np.full(UU.shape, np.nan, np.float32)
    img[ok] = hi_img[yi[ok], xi[ok]]
    # only paved ground can hold bays: drop greenery, and anything a building covers in this view
    x1, y1 = np.clip(X.astype(np.int64), 0, NPX - 1), np.clip(Y.astype(np.int64), 0, NPX - 1)
    rgb = without_np[y1, x1].astype(int)
    green = (rgb[..., 1] > rgb[..., 0] + 6) & (rgb[..., 1] > rgb[..., 2] + 10)
    # and anything the camera sees standing above the ground there (facades, balconies, walls)
    seen_h = H[y1, x1]
    raised = ~np.isfinite(seen_h) | (seen_h - ground_h(E_, N_) > 1.2)
    img[green | building[y1, x1] | raised] = np.nan
    return img, us, vs


def stripe_peaks(profile, min_gap):
    """Positions (indices) of bright stripes in a 1D profile: local maxima well above the noise."""
    mad = np.median(np.abs(profile - np.median(profile))) + 1e-6
    thr = np.median(profile) + 3.0 * mad
    cand = np.nonzero((profile > thr) & (profile >= np.roll(profile, 1)) & (profile >= np.roll(profile, -1)))[0]
    peaks = []
    for i in cand[np.argsort(-profile[cand])]:
        if all(abs(i - j) >= min_gap for j in peaks):
            peaks.append(int(i))
    return sorted(peaks)


def stripe_rows(img, us):
    """Rows of painted bays in a rectified, paved-only patch (rows = v, cols = u).

    The stripes are hand-drawn, so their spacing wanders: rather than assume one pitch, every
    stripe is found individually and each bay sits between two neighbouring stripes.
    -> rows [(v0, v1, [bay centre u, ...], sub, nsub, score)]
    """
    ok = np.isfinite(img)
    if ok.sum() < 500:
        return []
    fill = np.where(ok, img, np.nanmedian(img) if ok.any() else 0)
    hp = fill - ndimage.uniform_filter1d(fill, int(1.6 / RES), axis=1)    # thin bright stripes
    hp[~ok] = 0
    vert = ndimage.uniform_filter1d(hp, int(1.0 / RES), axis=0)          # stripes run ~5 m in v
    # bays are drawn 2.1-3.4 m wide, but some car parks are drawn stylised with wider bays
    gap_lo, gap_hi = int(2.1 / RES), int(7.6 / RES)

    def regular_gaps(pk):
        """Stripe gaps of a plausible, consistent width along one line."""
        gs = [b_ - a_ for a_, b_ in zip(pk, pk[1:]) if gap_lo <= b_ - a_ <= gap_hi]
        if not gs:
            return 0
        med = np.median(gs)
        return sum(1 for g_ in gs if abs(g_ - med) < 0.3 * med)

    # row score: how many regular stripe-to-stripe gaps this line crosses
    score = np.zeros(img.shape[0])
    for i in range(0, img.shape[0], 2):
        score[i:i + 2] = regular_gaps(stripe_peaks(vert[i], int(1.6 / RES)))
    score = ndimage.uniform_filter1d(score, int(0.4 / RES))
    rows = []
    lab_, nrow = ndimage.label(score >= 3)
    for k in range(1, nrow + 1):
        idx = np.nonzero(lab_ == k)[0]
        if (idx[-1] - idx[0] + 1) * RES < 2.5:
            continue
        # the stripes of this band, then where along v they are actually painted
        pk = stripe_peaks(hp[idx[0]:idx[-1] + 1].mean(0), int(1.6 / RES))
        if len(pk) < MIN_RUN + 1:
            continue
        lo_, hi_ = max(0, idx[0] - int(2 / RES)), min(hp.shape[0], idx[-1] + int(2 / RES))
        presence = np.array([np.mean([hp[i, max(0, p_ - 1):p_ + 2].max() for p_ in pk]) for i in range(lo_, hi_)])
        presence = ndimage.uniform_filter1d(presence, int(0.3 / RES))
        on = presence > 0.5 * presence.max()
        seg_lab, nseg = ndimage.label(on)
        for sgi in range(1, nseg + 1):
            sidx = np.nonzero(seg_lab == sgi)[0] + lo_
            L = (sidx[-1] - sidx[0] + 1) * RES
            if L < 3.0 or L > 13:
                continue
            nsub = 2 if L > 7.5 else 1                    # back-to-back double row
            for s_ in range(nsub):
                a0 = sidx[0] + int(s_ * len(sidx) / nsub)
                a1 = sidx[0] + int((s_ + 1) * len(sidx) / nsub) - 1
                pk2 = stripe_peaks(hp[a0:a1 + 1].mean(0), int(1.6 / RES))
                gaps = [(a_, b_) for a_, b_ in zip(pk2, pk2[1:]) if gap_lo <= b_ - a_ <= gap_hi]
                med = np.median([b_ - a_ for a_, b_ in gaps]) if gaps else 0
                centres = []
                for a_, b_ in gaps:
                    if abs((b_ - a_) - med) > 0.3 * med:
                        continue
                    ncar = max(1, round((b_ - a_) * RES / 2.6))       # cars per drawn bay
                    centres += [(a_ + (b_ - a_) * (j + 0.5) / ncar) * RES for j in range(ncar)]
                wide = med * RES > 3.4
                if len(centres) >= (MIN_RUN + 2 if wide else MIN_RUN):
                    # rows of normal-width bays win any overlap with stylised wide ones
                    rows.append((a0 * RES, (a1 + 1) * RES, centres, s_, nsub, float(len(centres)) * (0.3 if wide else 1.0)))
    return rows


class Footprints:
    """Parked-car footprints placed so far; a new car may not overlap any of them."""

    def __init__(self):
        self.grid = {}

    @staticmethod
    def poly(e, n, heading, L=4.6, W=2.1):
        c_, s_ = math.cos(heading), math.sin(heading)
        return Polygon([(e + c_ * a - s_ * b, n + s_ * a + c_ * b) for a, b in [(-L / 2, -W / 2), (L / 2, -W / 2), (L / 2, W / 2), (-L / 2, W / 2)]])

    def free(self, e, n, heading):
        p_ = self.poly(e, n, heading)
        gk = (int(e // 5), int(n // 5))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q in self.grid.get((gk[0] + dx, gk[1] + dy), []):
                    if p_.intersection(q).area > 0.4:
                        return False
        return True

    def add(self, e, n, heading):
        self.grid.setdefault((int(e // 5), int(n // 5)), []).append(self.poly(e, n, heading))


FOOTPRINTS = Footprints()
WIN, STRIDE = 50.0, 25.0          # bay-scan window (m) and step
MIN_RUN = 3                        # a row needs at least this many bays in a row


def paved_at(e, n, h):
    X, Y = proj(e, n, h)
    xi, yi = int(X), int(Y)
    if not (0 <= xi < NPX and 0 <= yi < NPX):
        return False
    return not greenish(without_np[yi, xi]) and not building[yi, xi]


def layout_lots(detected):
    """Every painted parking bay in the drawing, found window by window, filled like a busy town."""
    from collections import Counter
    why = Counter()
    bays = []                                   # (score, e, n, axis heading, row key)
    half = WIN / 2
    windows = [(e, n) for e in np.arange(-640, 640, STRIDE) for n in np.arange(-640, 640, STRIDE)
               if 0 <= proj(e, n, 0)[0] < NPX and 0 <= proj(e, n, 0)[1] < NPX]
    for wi, (ce, cn) in enumerate(windows):
        _, lane_dir, _ = nearest_lane(ce, cn)
        for th in (lane_dir % math.pi, (lane_dir + math.pi / 2) % math.pi):
            u = np.array([math.cos(th), math.sin(th)])
            v = np.array([-u[1], u[0]])
            origin = np.array([ce, cn]) - u * half - v * half
            img, us, vs = rectify(origin, u, v, WIN, WIN)
            rows = stripe_rows(img, us)
            for ri, (v0, v1, centres, sub, nsub, strength) in enumerate(rows):
                vc = (v0 + v1) / 2
                # each bay: valid if it's off the lanes and paved at both ends of the car
                cand = []
                for uc in centres:
                    e, nn = origin + u * uc + v * vc
                    gh = float(ground_h(np.array([e]), np.array([nn]))[0])
                    if on_lane(e, nn):
                        why["on lane"] += 1
                        cand.append(None)
                    elif not (paved_at(e + v[0] * 1.8, nn + v[1] * 1.8, gh) and paved_at(e - v[0] * 1.8, nn - v[1] * 1.8, gh)):
                        why["not paved / building"] += 1
                        cand.append(None)
                    else:
                        cand.append((uc, e, nn))
                # runs of neighbouring valid bays; keep runs of MIN_RUN or more
                runs, cur = [], []
                for c_ in cand + [None]:
                    if c_ is not None and (not cur or c_[0] - cur[-1][0] < 3.6):
                        cur.append(c_)
                        continue
                    if cur:
                        runs.append(cur)
                    cur = [c_] if c_ is not None else []
                for r_ in runs:
                    if len(r_) < MIN_RUN:
                        why["short run"] += len(r_)
                        continue
                    key = (wi, round(th, 3), ri)
                    for _, e_, n_ in r_:
                        bays.append((strength, e_, n_, th + math.pi / 2, key, sub, nsub, vc))
    # the same bay seen from overlapping windows: keep the strongest
    # a car park has one bay direction: drop bays that disagree with the strong rows around them
    if bays:
        B = np.array([[b_[1], b_[2], b_[3], b_[0]] for b_ in bays])
        agree = []
        for e, nn, ax, w in B:
            near = (np.abs(B[:, 0] - e) < 12) & (np.abs(B[:, 1] - nn) < 12)
            # doubled-angle vote so opposite directions count as the same axis
            vote = (B[near, 3] * np.exp(2j * B[near, 2])).sum()
            agree.append(abs(wrap(ax - np.angle(vote) / 2)) < math.radians(25))
        why["against local direction"] += int(len(agree) - sum(agree))
        bays = [b_ for b_, ok in zip(bays, agree) if ok]
    bays.sort(key=lambda b_: -b_[0])
    kept = []
    for b_ in bays:
        if FOOTPRINTS.free(b_[1], b_[2], b_[3]):
            FOOTPRINTS.add(b_[1], b_[2], b_[3])
            kept.append(b_)
    det = np.array([[c[0], c[1]] for c in detected]) if detected else np.zeros((0, 2))
    out, used = [], set()
    # nose-in: a row's cars face away from the nearest driving lane; double rows face their middle
    for strength, e, nn, axis, key, sub, nsub, vc in kept:
        d = np.array([math.cos(axis), math.sin(axis)])
        if nsub > 1:
            heading = axis if sub == 1 else axis + math.pi
        else:
            _, _, foot = nearest_lane(e, nn)
            heading = axis if np.dot([e - foot[0], nn - foot[1]], d) >= 0 else axis + math.pi
        near = np.nonzero(np.hypot(det[:, 0] - e, det[:, 1] - nn) < 2.0)[0] if len(det) else []
        if len(near):
            col = detected[near[0]][4] or palette_colour()
            used.update(int(i) for i in near)
        elif rng.random() < OCCUPANCY:
            col = palette_colour()
        else:
            continue
        h = float(ground_h(np.array([e]), np.array([nn]))[0])
        out.append([round(float(e), 2), round(float(nn), 2), round(h, 2), round(wrap(heading, 2 * math.pi), 3), col])
    print(f"bays: scanned {len(windows)} windows, {len(kept)} painted bays found, {len(out)} filled; rejected: {dict(why)}")
    return out, kept, used


lab, n = ndimage.label(mask)
cars, moving, small, trees = [], 0, 0, 0
for k, sl in enumerate(ndimage.find_objects(lab), start=1):
    jj, ii = np.nonzero(lab[sl] == k)
    if len(jj) * CELL * CELL < 3.0:          # smaller than a car's roof
        small += 1
        continue
    pts = np.stack([ge[ii + sl[1].start], gn[jj + sl[0].start]], 1)
    ctr = pts.mean(0)
    evals, evecs = np.linalg.eigh(np.cov((pts - ctr).T))
    major, minor = evecs[:, 1], evecs[:, 0]
    u = (pts - ctr) @ major
    w = (pts - ctr) @ minor
    L, W = u.max() - u.min() + CELL, w.max() - w.min() + CELL
    if W > 7.5 or L > 80:
        continue
    if L < CAR_L * 1.35 and W < CAR_W * 1.9:
        n_cars, head = 1, major                                    # one car, along its long side
    elif W >= 3.4:
        n_cars, head = max(1, round(L / ROW_PITCH)), minor         # side by side: cars across the row
    else:
        n_cars, head = max(1, round(L / LINE_PITCH)), major        # nose to tail along a kerb
    pitch = L / n_cars
    for j in range(n_cars):
        t = u.min() + pitch * (j + 0.5)
        e, nn = ctr + major * t
        if on_lane(e, nn):
            moving += 1
            continue
        h = float(dem[int((EXT - nn) // DC), int((e + EXT) // DC)])
        heading = math.atan2(head[1], head[0]) + (math.pi if (j * 7 + k) % 2 else 0.0)
        col = paint(e, nn, h)
        # cars here are almost never green: green paint or a green footprint is a redrawn tree
        if (col and greenish(bytes.fromhex(col[1:]))) or on_greenery(e, nn, h, heading):
            trees += 1
            continue
        cars.append([round(float(e), 2), round(float(nn), 2), round(h, 2), round(heading, 3), col])

raw_count = len(cars)
lot_cars, bays_found, used = layout_lots(cars)
bay_pts = np.array([[b_[1], b_[2]] for b_ in bays_found]) if bays_found else np.zeros((0, 2))
outside = [c for i, c in enumerate(cars) if i not in used
           and not (len(bay_pts) and np.hypot(bay_pts[:, 0] - c[0], bay_pts[:, 1] - c[1]).min() < 3.5)]
street = [c for c in orderly(outside) if FOOTPRINTS.free(c[0], c[1], c[3]) and (FOOTPRINTS.add(c[0], c[1], c[3]) or True)]
cars = lot_cars + street
print(f"car parks: {len(lot_cars)} cars in painted bays; streets: {len(street)} cars in kerbside rows")
json.dump({"cars": cars}, open("parked_cars.json", "w"), separators=(",", ":"))
print(f"parked_cars.json: {len(cars)} parked cars in tidy rows ({raw_count} detected) ({moving} on driving lanes dropped as moving traffic, "
      f"{trees} in greenery dropped as trees, {small} specks ignored)")
