"""Turn OSM footprints + the decoded height mosaic into clickable buildings.

For every mosaic pixel we know its surface height h. With the exact orthographic camera we can
invert pixel (X, Y, h) -> local ground coords (east, north). A pixel belongs to building b if that
ground point falls inside b's footprint (buffered slightly to catch walls) and it is above b's ground.

Outputs:
  buildings.json   per-building card data + footprint (local metres) + ground/roof heights
  idmap.png        mosaic-sized RGB image, building index encoded as R + 256*G (0 = none)
  aux/roads_check.png  OSM roads projected onto the illustration (alignment check)
"""
import json
import math

import numpy as np
from PIL import Image, ImageDraw
from shapely.geometry import Polygon, LineString, Point
from shapely.prepared import prep

g = json.load(open("tiles_raw/grid.json"))
LAT0, LON0, MPP = g["lat"], g["lon"], g["M_PER_PX"]
NPX = (2 * g["R"] + 1) * g["CORE"]
X0 = Y0 = NPX / 2
S2 = math.sqrt(0.5)

# WGS84 local radii -> accurate lat/lon <-> local east/north metres
a, f = 6378137.0, 1 / 298.257223563
e2 = f * (2 - f)
phi = math.radians(LAT0)
Nr = a / math.sqrt(1 - e2 * math.sin(phi) ** 2)
Mr = a * (1 - e2) / (1 - e2 * math.sin(phi) ** 2) ** 1.5
KX, KY = math.radians(1) * Nr * math.cos(phi), math.radians(1) * Mr


def ll2en(lat, lon):
    return ((lon - LON0) * KX, (lat - LAT0) * KY)


def project(e, n, h):
    """local east/north/height (m, height relative to target ground) -> mosaic pixel."""
    x = S2 * e - S2 * n
    y = 0.5 * e + 0.5 * n + S2 * h
    return X0 + x / MPP, Y0 - y / MPP


H = np.load("height_mosaic.npy")
Ys, Xs = np.mgrid[0:NPX, 0:NPX]
x = (Xs + 0.5 - X0) * MPP
y = (Y0 - (Ys + 0.5)) * MPP
A = x / S2
B = 2 * (y - S2 * H)
E = (A + B) / 2
Nn = (B - A) / 2
valid = np.isfinite(H)

# ------------------------------------------------------------------ OSM
d = json.load(open("osm_area.json"))["elements"]
nodes = {e["id"]: (e["lat"], e["lon"]) for e in d if e["type"] == "node" and "lat" in e}
ways = {e["id"]: e for e in d if e["type"] == "way"}

blds = []
for e in d:
    t = e.get("tags", {})
    if "building" not in t:
        continue
    rings = []
    if e["type"] == "way":
        rings = [e["nodes"]]
    elif e["type"] == "relation":
        rings = [ways[m["ref"]]["nodes"] for m in e.get("members", []) if m["type"] == "way" and m.get("role") == "outer" and m["ref"] in ways]
    for ring in rings:
        pts = [ll2en(*nodes[i]) for i in ring if i in nodes]
        if len(pts) < 4:
            continue
        poly = Polygon(pts).buffer(0)
        if poly.is_empty or poly.geom_type != "Polygon" or poly.area < 12:
            continue
        blds.append({"poly": poly, "tags": t, "osm": f"{e['type']}/{e['id']}"})
import os
OV = {} if os.environ.get("NO_OVERRIDES") or not os.path.exists("footprint_overrides.json") else json.load(open("footprint_overrides.json"))
for b_ in blds:
    b_["poly_osm"] = b_["poly"]
    if b_["osm"] in OV:
        b_["poly"] = Polygon(OV[b_["osm"]]).buffer(0)
        b_["fixed"] = True
print("OSM building polygons:", len(blds), "| outlines replaced from 3D:", sum(1 for b_ in blds if b_.get("fixed")))

pois = []
for e in d:
    if e["type"] == "node" and e.get("tags") and "building" not in e["tags"]:
        t = e["tags"]
        if "name" in t or "addr:housenumber" in t:
            pois.append((Point(ll2en(e["lat"], e["lon"])), t))

# ------------------------------------------------------------------ ground-plane rasters
RES = 0.5
ext = 1000
G = int(2 * ext / RES)


def to_r(pts):
    return [((px + ext) / RES, (ext - py) / RES) for px, py in pts]


fp_img = Image.new("I", (G, G), 0)
ring_img = Image.new("I", (G, G), 0)
dfp, dring = ImageDraw.Draw(fp_img), ImageDraw.Draw(ring_img)
order = sorted(range(len(blds)), key=lambda i: -blds[i]["poly"].area)  # big first, small on top
for i in order:
    p = blds[i]["poly"]
    ring = p.buffer(7).difference(p.buffer(1.5))
    for geom in getattr(ring, "geoms", [ring]):
        if geom.geom_type == "Polygon" and not geom.is_empty:
            dring.polygon(to_r(geom.exterior.coords), fill=i + 1)
for i in order:
    dfp.polygon(to_r(blds[i]["poly"].buffer(0.8, join_style=2).exterior.coords), fill=i + 1)
for i in order:  # unbuffered interiors win over neighbours' wall buffers
    dfp.polygon(to_r(blds[i]["poly"].exterior.coords), fill=i + 1)
inner_img = Image.new("I", (G, G), 0)
dinner = ImageDraw.Draw(inner_img)
for i in order:
    sh = blds[i]["poly"].buffer(-1.0)
    for geom in getattr(sh, "geoms", [sh]):
        if geom.geom_type == "Polygon" and not geom.is_empty:
            dinner.polygon(to_r(geom.exterior.coords), fill=i + 1)
inner = np.asarray(inner_img, np.int32)
fp = np.asarray(fp_img, np.int32)
rg = np.asarray(ring_img, np.int32)

ci = np.clip(((E + ext) / RES).astype(np.int64), 0, G - 1)
cj = np.clip(((ext - Nn) / RES).astype(np.int64), 0, G - 1)
inside = valid & (np.abs(E) < ext) & (np.abs(Nn) < ext)
bid = np.where(inside, fp[cj, ci], 0)
rid = np.where(inside, rg[cj, ci], 0)
iid = np.where(inside, inner[cj, ci], 0).ravel()

# ------------------------------------------------------------------ ground / roof per building
hv = H[valid]
order_r = np.argsort(rid[valid], kind="stable")
rs, hs = rid[valid][order_r], hv[order_r]
starts = np.searchsorted(rs, np.arange(len(blds) + 2))
ground = np.full(len(blds) + 1, np.nan, np.float32)
for i in range(1, len(blds) + 1):
    seg = hs[starts[i]:starts[i + 1]]
    if seg.size > 30:
        ground[i] = np.percentile(seg, 20)

# fallback ground: coarse terrain grid from low percentiles of all pixels
cell = 20
gi = ((E[valid] + ext) // cell).astype(np.int64)
gj = ((ext - Nn[valid]) // cell).astype(np.int64)
GC = 2 * ext // cell
key = gj * GC + gi
o = np.argsort(key, kind="stable")
ks, hk = key[o], hv[o]
uk, st = np.unique(ks, return_index=True)
dem = np.full(GC * GC, np.nan, np.float32)
for k, s0, s1 in zip(uk, st, list(st[1:]) + [len(ks)]):
    if s1 - s0 > 20:
        dem[k] = np.percentile(hk[s0:s1], 8)
dem = dem.reshape(GC, GC)


def dem_at(e_, n_):
    i_ = int((e_ + ext) // cell)
    j_ = int((ext - n_) // cell)
    win = dem[max(0, j_ - 2):j_ + 3, max(0, i_ - 2):i_ + 3]
    return float(np.nanmedian(win)) if np.isfinite(win).any() else 0.0


b_flat = bid.ravel()
h_flat = np.nan_to_num(H, nan=-999).ravel()
order_b = np.argsort(b_flat, kind="stable")
bs = b_flat[order_b]
bstarts = np.searchsorted(bs, np.arange(len(blds) + 2))

USE = {"apartments": "Apartments", "residential": "Residential", "house": "House", "detached": "House", "semidetached_house": "House",
       "terrace": "Terraced houses", "commercial": "Commercial", "retail": "Retail", "office": "Offices", "industrial": "Industrial",
       "school": "School", "university": "University", "college": "College", "kindergarten": "Kindergarten", "hospital": "Hospital",
       "mosque": "Mosque", "church": "Church", "cathedral": "Cathedral", "public": "Public building", "government": "Government",
       "hotel": "Hotel", "garage": "Garage", "garages": "Garages", "construction": "Under construction", "civic": "Civic",
       "warehouse": "Warehouse", "kiosk": "Kiosk", "dormitory": "Dormitory", "sports_hall": "Sports hall", "train_station": "Station"}
AMEN = {"school": "School", "kindergarten": "Kindergarten", "library": "Library", "place_of_worship": "Place of worship", "hospital": "Hospital",
        "clinic": "Clinic", "townhall": "Town hall", "police": "Police", "post_office": "Post office", "university": "University",
        "bank": "Bank", "pharmacy": "Pharmacy", "restaurant": "Restaurant", "cafe": "Café", "fuel": "Fuel station"}

idmap = np.zeros((NPX, NPX), np.int32)
out = []
for i in range(1, len(blds) + 1):
    b = blds[i - 1]
    pix = order_b[bstarts[i]:bstarts[i + 1]]
    if pix.size < 40:
        continue
    terrain = dem_at(*b["poly"].centroid.coords[0])
    gr = ground[i] if np.isfinite(ground[i]) else terrain
    if gr > terrain + 3.0:  # ring polluted by attached neighbours / podiums -> trust local terrain
        gr = terrain
    hp = h_flat[pix]
    above = hp > gr + 1.0
    if above.sum() < 40:
        continue
    roof = float(np.percentile(hp[above], 95))
    gr = float(gr)
    height = float(roof - gr)
    if height < 2.0:
        continue
    k = len(out) + 1
    idmap.ravel()[pix[above]] = k
    # one flat roof for the outline box: median height of roof-interior pixels (ignores walls, rooftop boxes, antennas)
    fp_pts = list(b["poly"].simplify(0.8).exterior.coords)
    pa = pix[above]
    interior = hp[above][iid[pa] == i]
    roof_main = float(np.median(interior)) if interior.size >= 20 else float(np.percentile(hp[above], 75))
    t = b["tags"]
    P = prep(b.get("poly_osm", b["poly"]).union(b["poly"]).buffer(0.5))
    inside_pois = [pt for pt in pois if P.contains(pt[0])]
    names_in = sorted({p[1]["name"] for p in inside_pois if "name" in p[1]})[:6]
    addr = None
    if "addr:street" in t or "addr:housenumber" in t:
        addr = " ".join(x for x in (t.get("addr:street"), t.get("addr:housenumber")) if x)
    else:
        for _, pt in inside_pois:
            if "addr:street" in pt:
                addr = " ".join(x for x in (pt.get("addr:street"), pt.get("addr:housenumber")) if x)
                break
    use = USE.get(t.get("building"))
    for key_ in ("amenity", "shop", "office", "tourism", "leisure"):
        if not use and key_ in t:
            use = AMEN.get(t[key_], t[key_].replace("_", " ").capitalize())
    lv = t.get("building:levels")
    out.append({
        "id": k, "osm": b["osm"],
        "name": t.get("name") or t.get("name:sq") or t.get("name:en"),
        "addr": addr, "use": use or "Building",
        "levels": lv, "levels_est": max(1, round(height / 3.0)),
        "start": t.get("start_date"),
        "height": round(height, 1), "ground": round(float(gr), 2), "roof": round(roof, 2),
        "inside": names_in,
        "fp": [[round(px, 2), round(py, 2)] for px, py in fp_pts],
        "roof_main": round(min(roof_main, roof), 2),
        "fixed": bool(b.get("fixed")),
    })

print("clickable buildings:", len(out), "| named:", sum(1 for o_ in out if o_["name"]), "| with address:", sum(1 for o_ in out if o_["addr"]),
      "| covered px:", f"{(idmap > 0).mean():.1%}")
json.dump({"lat0": LAT0, "lon0": LON0, "mpp": MPP, "npx": NPX, "buildings": out}, open("buildings.json", "w"), ensure_ascii=False)
rgb = np.stack([idmap % 256, (idmap // 256) % 256, np.zeros_like(idmap)], -1).astype(np.uint8)
Image.fromarray(rgb).save("idmap.png")

# ------------------------------------------------------------------ alignment check: OSM roads on the illustration
day = Image.open("mosaic_styled.png").convert("RGB")
dr = ImageDraw.Draw(day, "RGBA")
for e in d:
    t = e.get("tags", {})
    if e["type"] == "way" and t.get("highway") in ("primary", "secondary", "tertiary", "residential", "service", "unclassified", "living_street", "pedestrian"):
        pts = [ll2en(*nodes[i]) for i in e["nodes"] if i in nodes]
        xy = [project(px, py, dem_at(px, py)) for px, py in pts]
        dr.line(xy, fill=(230, 0, 140, 200), width=3)
for o_ in out[:400]:
    xy = [project(px, py, o_["ground"]) for px, py in o_["fp"]]
    dr.line(xy, fill=(0, 120, 255, 160), width=2)
day.resize((1536, 1536)).save("aux/roads_check.png")
day.crop((1100, 1100, 1900, 1900)).save("aux/roads_check_zoom.png")
