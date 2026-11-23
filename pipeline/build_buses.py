"""Bus lines for the simulation: OSM route relations + stops + timetable -> buses.json.

Inputs (in pipeline/):
  roads.json            road graph (build_roads.py; links carry their OSM way id)
  bus_routes.json       Overpass: every route=bus relation in Prishtinë, with ways and nodes:
      [out:json][timeout:180];area["name:en"="Pristina"]["boundary"="administrative"]->.a;
      relation["route"="bus"](area.a)->.r;.r out body;.r >;out body qt;
  bus_stops.json        Overpass: every bus stop / platform in Prishtinë:
      [out:json][timeout:120];area["name:en"="Pristina"]["boundary"="administrative"]->.a;
      (node["highway"="bus_stop"](area.a);node["public_transport"="platform"]["bus"="yes"](area.a););out body;
  bus_schedule.json     timetable per line (committed; see that file for sources)

Most Prishtinë route relations list their roads but not their stops, so stops are matched
geometrically: a stop belongs to a route variant if it lies within STOP_M of the route, on the
right-hand side of the direction of travel (or on a one-way street), ordered by distance along it.

Output: buses.json with, per route variant, the full stop list (distance along the route) and the
"passes" through the simulated area as lane paths [link index, forward?] with stops placed on them.
"""
import bisect
import json
import math
from collections import defaultdict

STOP_M = 22.0           # max distance from a stop to the route line
SIDE_SLACK_M = 3.0      # stops this close to the centre line count for both directions
MIN_PASS_M = 40.0

R = json.load(open("roads.json"))
LAT0, LON0 = R["lat0"], R["lon0"]
a, f = 6378137.0, 1 / 298.257223563
e2 = f * (2 - f)
phi = math.radians(LAT0)
Nr = a / math.sqrt(1 - e2 * math.sin(phi) ** 2)
Mr = a * (1 - e2) / (1 - e2 * math.sin(phi) ** 2) ** 1.5
KX, KY = math.radians(1) * Nr * math.cos(phi), math.radians(1) * Mr


def ll2en(lat, lon):
    return ((lon - LON0) * KX, (lat - LAT0) * KY)


els = json.load(open("bus_routes.json"))["elements"]
nodes = {e["id"]: e for e in els if e["type"] == "node"}
ways = {e["id"]: e for e in els if e["type"] == "way"}
rels = [e for e in els if e["type"] == "relation" and e.get("tags", {}).get("route") == "bus"]
stop_nodes = [e for e in json.load(open("bus_stops.json"))["elements"] if e.get("tags", {}).get("name")]
schedule = json.load(open("bus_schedule.json"))

# ------------------------------------------------------------------ geometry helpers
class Polyline:
    def __init__(self, pts):
        self.p = pts
        self.cum = [0.0]
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            self.cum.append(self.cum[-1] + math.hypot(x2 - x1, y2 - y1))
        self.length = self.cum[-1]

    def project(self, x, y):
        """-> (distance along, lateral distance, signed side: + = right of travel direction)."""
        best = (float("inf"), 0.0, 0.0)
        for i, ((x1, y1), (x2, y2)) in enumerate(zip(self.p, self.p[1:])):
            dx, dy = x2 - x1, y2 - y1
            L2 = dx * dx + dy * dy
            if L2 == 0:
                continue
            t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
            px, py = x1 + dx * t, y1 + dy * t
            d = math.hypot(x - px, y - py)
            if d < best[0]:
                side = ((x - px) * dy - (y - py) * dx) / math.sqrt(L2)   # right-hand normal is (dy, -dx)
                best = (d, self.cum[i] + t * math.sqrt(L2), side)
        return best[1], best[0], best[2]


def chain_ways(rel):
    """Ordered list of node-id lists, each oriented in the direction of travel."""
    seq = [m["ref"] for m in rel["members"] if m["type"] == "way" and m["role"] in ("", "forward", "backward", "route") and m["ref"] in ways]
    out = []
    for k, wid in enumerate(seq):
        ids = [i for i in ways[wid]["nodes"] if i in nodes]
        if len(ids) < 2:
            continue
        if out:
            end = out[-1][1][-1]
            if ids[-1] == end and ids[0] != end:
                ids = ids[::-1]
            elif ids[0] != end:
                # gap: orient towards the previous end
                pe = ll2en(nodes[end]["lat"], nodes[end]["lon"])
                d0 = math.dist(pe, ll2en(nodes[ids[0]]["lat"], nodes[ids[0]]["lon"]))
                d1 = math.dist(pe, ll2en(nodes[ids[-1]]["lat"], nodes[ids[-1]]["lon"]))
                if d1 < d0:
                    ids = ids[::-1]
        elif k + 1 < len(seq):
            nxt = set(ways[seq[k + 1]]["nodes"]) if seq[k + 1] in ways else set()
            if ids[0] in nxt and ids[-1] not in nxt:
                ids = ids[::-1]
        out.append((wid, ids))
    return out


# ------------------------------------------------------------------ simulation lanes (same order as network.ts)
RN = R["nodes"]
lane_geom = []   # (link index, forward?) -> polyline in local metres
for li, l in enumerate(R["links"]):
    pts = [(RN[i][0], RN[i][1]) for i in l["pts"]]
    lane_geom.append({(li, True): pts, (li, False): pts[::-1]})
link_by_osm = {}
for li, l in enumerate(R["links"]):
    link_by_osm.setdefault(l["osm"], []).append(li)
boundary = set(R["boundary"])


def lane_ends(li, fwd):
    p = R["links"][li]["pts"]
    return (p[0], p[-1]) if fwd else (p[-1], p[0])


lane_line, lane_len, lanes_out, all_lanes = {}, {}, {}, []
for li, l in enumerate(R["links"]):
    for fwd in ([True] if l["oneway"] else [True, False]):
        key = (li, fwd)
        lane_line[key] = Polyline(lane_geom[li][key])
        lane_len[key] = lane_line[key].length
        all_lanes.append(key)
starts_at = defaultdict(list)
for key in all_lanes:
    starts_at[lane_ends(*key)[0]].append(key)
for key in all_lanes:
    lanes_out[key] = [k for k in starts_at[lane_ends(*key)[1]] if k[0] != key[0]]

# spatial grid of lanes, and the bounding box of the simulated road network
CELL = 25.0
grid = defaultdict(set)
for key in all_lanes:
    pts = lane_line[key].p
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        n = max(1, int(math.hypot(x2 - x1, y2 - y1) / 5))
        for j in range(n + 1):
            x, y = x1 + (x2 - x1) * j / n, y1 + (y2 - y1) * j / n
            grid[(int(x // CELL), int(y // CELL))].add(key)
ALL_X = [p[0] for k in all_lanes for p in lane_line[k].p]
ALL_Y = [p[1] for k in all_lanes for p in lane_line[k].p]
BBOX = (min(ALL_X) - 10, min(ALL_Y) - 10, max(ALL_X) + 10, max(ALL_Y) + 10)


def near_lanes(x, y):
    i, j = int(x // CELL), int(y // CELL)
    out = set()
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            out |= grid.get((i + di, j + dj), set())
    return out


def route_point(route, d):
    i = max(1, min(len(route.cum) - 1, bisect.bisect_left(route.cum, d)))
    (x1, y1), (x2, y2) = route.p[i - 1], route.p[i]
    seg = route.cum[i] - route.cum[i - 1] or 1
    t = max(0.0, min(1.0, (d - route.cum[i - 1]) / seg))
    return x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, math.atan2(y2 - y1, x2 - x1)


def windowed_lateral(route, x, y, d_lo, d_hi):
    best = (float("inf"), 0.0)
    i0 = max(1, bisect.bisect_left(route.cum, d_lo))
    i1 = min(len(route.p) - 1, bisect.bisect_right(route.cum, d_hi) + 1)
    for i in range(i0, i1 + 1):
        (x1, y1), (x2, y2) = route.p[i - 1], route.p[i]
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy or 1e-9
        t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
        dd = math.hypot(x - x1 - dx * t, y - y1 - dy * t)
        if dd < best[0]:
            best = (dd, route.cum[i - 1] + t * math.sqrt(L2))
    return best


def fit(route, key, d_lo, d_hi):
    pl = lane_line[key]
    n = max(2, int(pl.length / 5))
    lats = []
    for j in range(n + 1):
        sa = pl.length * j / n
        idx = max(1, min(len(pl.cum) - 1, bisect.bisect_left(pl.cum, sa)))
        (x1, y1), (x2, y2) = pl.p[idx - 1], pl.p[idx]
        t = (sa - pl.cum[idx - 1]) / ((pl.cum[idx] - pl.cum[idx - 1]) or 1)
        lats.append(windowed_lateral(route, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, d_lo, d_hi)[0])
    return sum(lats) / len(lats)


# simulated area = what build_roads.py kept: projected within the mosaic + its margin
NPX, MPP = R["npx"], R["mpp"]
MARGIN_PX = 220
S2 = math.sqrt(0.5)


def in_area(x, y):
    X = NPX / 2 + (S2 * x - S2 * y) / MPP
    Y = NPX / 2 - (0.5 * x + 0.5 * y) / MPP
    m = MARGIN_PX - 15   # a little inside, so entry/exit points sit on the cut lanes
    return -m <= X <= NPX + m and -m <= Y <= NPX + m


def inside_intervals(route, step=5.0):
    out, cur, d = [], None, 0.0
    while d <= route.length:
        x, y, _ = route_point(route, d)
        if in_area(x, y):
            cur = cur or [d, d]
            cur[1] = d
        elif cur:
            out.append(tuple(cur)); cur = None
        d += step
    if cur:
        out.append(tuple(cur))
    return [iv for iv in out if iv[1] - iv[0] >= MIN_PASS_M]


def end_lane(route, d, entering):
    """Lane where the route enters (or leaves) the area at distance d -> (lane, s, at map edge?)."""
    for off in range(0, 60, 4):
        dd = d + off if entering else d - off
        x, y, h = route_point(route, dd)
        best = None
        for key in near_lanes(x, y):
            sa, lat, _ = lane_line[key].project(x, y)
            pl = lane_line[key]
            k = max(1, min(len(pl.cum) - 1, bisect.bisect_left(pl.cum, sa)))
            lh = math.atan2(pl.p[k][1] - pl.p[k - 1][1], pl.p[k][0] - pl.p[k - 1][0])
            dh = abs((lh - h + math.pi) % (2 * math.pi) - math.pi)
            if lat > 9 or dh > math.radians(45):
                continue
            if best is None or lat < best[1]:
                best = (key, lat, sa)
        if best:
            key, _, sa = best
            edge_node = lane_ends(*key)[0] if entering else lane_ends(*key)[1]
            at_edge = edge_node in boundary
            if at_edge:
                sa = 0.0 if entering else lane_len[key]
            return key, sa, at_edge
    return None


def match_path(route, d_in, d_out, src, dst):
    """Shortest lane path src -> dst, each lane's cost = length x (1 + (mean distance to route / 4)^2)."""
    import heapq
    xs = [route_point(route, d)[:2] for d in range(int(d_in), int(d_out) + 1, 10)]
    x0, x1 = min(p[0] for p in xs) - 60, max(p[0] for p in xs) + 60
    y0, y1 = min(p[1] for p in xs) - 60, max(p[1] for p in xs) + 60
    cost_cache = {}

    def cost(key):
        if key not in cost_cache:
            pl = lane_line[key]
            if not any(x0 <= x <= x1 and y0 <= y <= y1 for x, y in pl.p):
                cost_cache[key] = None
            else:
                m = fit(route, key, d_in - 40, d_out + 40)
                cost_cache[key] = None if m > 25 else pl.length * (1 + (m / 4) ** 2) + 1
        return cost_cache[key]

    if src == dst:
        return [src]
    pq, best, prev = [(0.0, src)], {src: 0.0}, {}
    while pq:
        c, k = heapq.heappop(pq)
        if k == dst:
            break
        if c > best.get(k, 1e18):
            continue
        for o in lanes_out[k]:
            w = cost(o)
            if w is None:
                continue
            if c + w < best.get(o, 1e18):
                best[o], prev[o] = c + w, k
                heapq.heappush(pq, (c + w, o))
    if dst not in prev:
        return None
    path, k = [dst], dst
    while k != src:
        k = prev[k]
        path.append(k)
    return path[::-1]


# ------------------------------------------------------------------ per variant
PALETTE = ["#c4473a", "#2f6db5", "#3c8d4f", "#d08a1e", "#7b4fa3", "#1d8a8a", "#b5487c", "#5a6b2e", "#a0522d", "#4a5f8c"]
variants, line_refs = [], {}
for rel in sorted(rels, key=lambda r: (r["tags"].get("ref") or "~", r["id"])):
    t = rel["tags"]
    ref = t.get("ref")
    if not ref or ref not in schedule["lines"]:
        continue
    chain = chain_ways(rel)
    pts, way_spans = [], []
    for wid, ids in chain:
        seg = [ll2en(nodes[i]["lat"], nodes[i]["lon"]) for i in ids]
        if pts and math.dist(pts[-1], seg[0]) < 0.5:
            seg = seg[1:]
        start = len(pts)
        pts.extend(seg)
        way_spans.append((wid, start, len(pts)))
    if len(pts) < 2:
        continue
    route = Polyline(pts)
    oneway_ways = {wid for wid, _ in chain if ways[wid].get("tags", {}).get("oneway") in ("yes", "-1") or ways[wid].get("tags", {}).get("junction") == "roundabout"}

    # stops: near the line, on the right-hand side, ordered along the route
    cand = []
    for s in stop_nodes:
        x, y = ll2en(s["lat"], s["lon"])
        d_along, lat, side = route.project(x, y)
        if lat > STOP_M:
            continue
        # which way is the stop next to? one-way streets accept stops on either side
        k = max(0, min(len(route.cum) - 1, bisect.bisect_left(route.cum, d_along)))
        on_oneway = any(a_ <= k <= b_ and wid in oneway_ways for wid, a_, b_ in way_spans)
        if side < -SIDE_SLACK_M and not on_oneway:
            continue
        cand.append((d_along, lat, s))
    cand.sort(key=lambda c: c[0])
    stops = []
    for d_along, lat, s in cand:
        name = s["tags"]["name"]
        if stops and (d_along - stops[-1]["d"] < 60 and (stops[-1]["name"] == name or d_along - stops[-1]["d"] < 15)):
            if lat < stops[-1]["_lat"]:
                stops[-1] = {"name": name, "d": round(d_along, 1), "lat": s["lat"], "lon": s["lon"], "osm": s["id"], "_lat": lat}
            continue
        stops.append({"name": name, "d": round(d_along, 1), "lat": s["lat"], "lon": s["lon"], "osm": s["id"], "_lat": lat})
    for s in stops:
        del s["_lat"]

    # passes through the simulated area: where the route is inside it, the lane path between its
    # entry and exit that stays closest to the route line (shortest path, penalising distance)
    out_passes = []
    for d_in, d_out in inside_intervals(route):
        entry = end_lane(route, d_in, entering=True)
        exit_ = end_lane(route, d_out, entering=False)
        if not entry or not exit_:
            continue
        path = match_path(route, d_in, d_out, entry[0], exit_[0])
        if not path:
            continue
        s0 = entry[1]
        lanes = [[li, fwd] for li, fwd in path]
        total = sum(lane_len[k] for k in path) - s0
        if total < MIN_PASS_M:
            continue
        pstops = []
        for si, st in enumerate(stops):
            if not (d_in - 10 <= st["d"] <= d_out + 10):
                continue
            x, y = ll2en(st["lat"], st["lon"])
            best = None
            for k, key in enumerate(path):
                sa, lat, _ = lane_line[key].project(x, y)
                if k == 0 and sa < s0:
                    continue
                if best is None or lat < best[1]:
                    best = (k, lat, sa)
            if best and best[1] <= STOP_M:
                pstops.append({"stop": si, "lane": best[0], "s": round(best[2], 1)})
        pstops.sort(key=lambda q: (q["lane"], q["s"]))
        # a pass may start / end mid-map only at a stop (a terminus); otherwise the OSM relation is
        # broken there and a bus would pop in or out of nowhere, so skip it
        pos = lambda q: sum(lane_len[k] for k in path[:q["lane"]]) + q["s"]
        end_pos = sum(lane_len[k] for k in path[:-1]) + exit_[1]
        if not entry[2] and not (pstops and pos(pstops[0]) - s0 < 80):
            continue
        if not exit_[2] and not (pstops and end_pos - pos(pstops[-1]) < 80):
            continue
        out_passes.append({
            "lanes": lanes, "s0": round(s0, 1), "sEnd": round(exit_[1], 1), "dStart": round(d_in, 1), "dEnd": round(d_out, 1),
            "entersAtEdge": entry[2], "leavesAtEdge": exit_[2], "stops": pstops,
        })
    if not out_passes:
        continue
    if ref not in line_refs:
        line_refs[ref] = PALETTE[len(line_refs) % len(PALETTE)]
    variants.append({
        "id": rel["id"], "ref": ref, "name": t.get("name"), "from": t.get("from"), "to": t.get("to"),
        "length": round(route.length, 1), "stops": stops, "passes": out_passes,
    })

lines = {}
for ref, color in line_refs.items():
    sch = schedule["lines"][ref]
    lines[ref] = {"ref": ref, "color": sch.get("color", color), **{k: v for k, v in sch.items() if k != "color"}}
json.dump({"source": schedule.get("source"), "runningSpeedKmh": schedule.get("runningSpeedKmh", 17),
           "dwellS": schedule.get("dwellS", 18), "lines": lines, "variants": variants},
          open("buses.json", "w"), ensure_ascii=False, separators=(",", ":"))

print(f"buses.json: {len(lines)} lines, {len(variants)} variants pass through the map")
for v in variants:
    n_in = sum(len(p["stops"]) for p in v["passes"])
    flags = ", ".join(f"{p['dEnd'] - p['dStart']:.0f} m {'edge' if p['entersAtEdge'] else 'MID'}->{'edge' if p['leavesAtEdge'] else 'MID'}" for p in v["passes"])
    print(f"  {v['ref']:>3} {v['id']} {v['length'] / 1000:5.1f} km, {len(v['stops']):2d} stops ({n_in} in map) | passes: {flags}")
