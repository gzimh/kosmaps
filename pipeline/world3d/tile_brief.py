"""Write the data sheet for one 45° tile: every building whose base is in the tile, with its pixel
position in the tile, what it is, floors, height and roof — so the image model can reason about
heights instead of guessing them from a flat photo.

Usage: python world3d/tile_brief.py <world.json> <grid.json> <i> <j>   (prints the sheet)
"""
import json
import math
import sys

from shapely.geometry import Polygon

world = json.load(open(sys.argv[1]))
grid = json.load(open(sys.argv[2]))
i, j = int(sys.argv[3]), int(sys.argv[4])
o = world["origin"]
m_lat = 111132.92 - 559.82 * math.cos(2 * math.radians(o["lat"]))
m_lon = 111412.84 * math.cos(math.radians(o["lat"]))
S = math.sqrt(0.5)
step = grid["CORE"] * grid["M_PER_PX"]
sr, su = (i - grid["R"]) * step, (grid["R"] - j) * step
cx = (grid["lon"] - o["lon"]) * m_lon + sr * S + su
cy = (grid["lat"] - o["lat"]) * m_lat - sr * S + su
SIZE, MPP = grid["SIZE"], grid["M_PER_PX"]


def to_px(x, y, z=0.0):
    """Tile pixel of a point (x east, y north, z up, metres): camera looks NE, tilted 45° down."""
    dx, dy = x - cx, y - cy
    right = (dx - dy) * S
    up = (dx + dy) / 2 + z * S
    return SIZE / 2 + right / MPP, SIZE / 2 - up / MPP


KIND = {"yes": "building", "residential": "villa", "house": "villa"}
rows = []
for b in world["buildings"]:
    p = Polygon(b["poly"])
    c = p.centroid
    x, y = to_px(c.x, c.y)
    if not (0 <= x < SIZE and 0 <= y < SIZE):
        continue
    kind = b.get("name") or KIND.get(b["kind"], b["kind"].replace("_", " "))
    if kind == "building" and 60 < p.area < 450:
        kind = "villa"
    wall_px = b["h"] * S / MPP
    roof = "pitched terracotta hip roof" if b["roof"] == "hip" else "flat roof"
    rows.append((y, x, f"- base at ({x:.0f}, {y:.0f}): {kind}, {b['levels']} floor{'s' if b['levels'] != 1 else ''}, "
                       f"{b['h']:.0f} m (walls ~{wall_px:.0f} px tall), {roof}, footprint {p.area:.0f} m²"))
rows.sort()
places = []
for pl in world["places"]:
    x, y = to_px(pl["x"], pl["y"])
    if 0 <= x < SIZE and 0 <= y < SIZE:
        places.append(f"- {pl['name']} ({pl['kind']}) at ({x:.0f}, {y:.0f})")

print(f"Pixel positions are in the FIRST image's {SIZE}x{SIZE} frame (x right, y down); 'base' is the centre "
      f"of the building's footprint on the ground. 1 m of wall height = {S / MPP:.1f} px straight up the image.")
print(f"Buildings ({len(rows)}), from OpenStreetMap footprints with heights measured from the aerial photo "
      f"(shadows and roof lean) and published floor counts:")
print("\n".join(r[2] for r in rows) if rows else "- none (no buildings in this tile)")
if places:
    print("Named places (do not write their names in the image):")
    print("\n".join(dict.fromkeys(places)))
