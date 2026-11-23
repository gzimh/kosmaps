/** Road graph for the traffic simulation, built from public/data/roads.json (pipeline/build_roads.py). */

export interface RoadsFile {
  npx: number;
  mpp: number;
  /** [east, north, height] in local metres (height relative to the map's reference ground). */
  nodes: [number, number, number][];
  links: {
    pts: number[];
    cls: string;
    link: boolean;
    oneway: boolean;
    lanes: number | null;
    maxspeed: number | null;
    name: string | null;
    len: number;
  }[];
  signals: number[];
  yields: number[];
  crossings: number[];
  boundary: number[];
}

/** One direction of travel along a link, offset to the right-hand side. */
export interface Lane {
  id: number;
  from: number;
  to: number;
  cls: string;
  /** Priority at junctions: higher wins. */
  rank: number;
  /** Speed limit, m/s. */
  vmax: number;
  /** Peak-hour density target, vehicles per km. */
  density: number;
  /** Flattened [e, n, h] polyline (already offset to the lane). */
  pts: Float64Array;
  /** Cumulative distance at each vertex. */
  cum: Float64Array;
  len: number;
  out: number[];
  reverse: number;
  startsAtBoundary: boolean;
  endsAtBoundary: boolean;
  /** Lane starts at a dead end (driveway / car park entrance): cars can pull out here. */
  startsAtDeadEnd: boolean;
  /** Lane ends at a dead end: leaving cars can park here instead of U-turning. */
  endsAtDeadEnd: boolean;
  /** Metres to the nearest place a car can leave the map (edge or dead end), via this lane. */
  exitDist: number;
  /** Heading (radians, atan2(dn, de)) at the start and end of the lane. */
  headStart: number;
  headEnd: number;
  /** Traffic-light stop line, if this lane ends at a signalised node. */
  signal: { ctrl: number; group: number; stopAt: number } | null;
  /** Lane must give way to higher-ranked traffic at its end junction. */
  yieldAtEnd: boolean;
}

export interface SignalController {
  groups: number;
  offset: number;
}

const RANK: Record<string, number> = {
  trunk: 6, primary: 5, secondary: 4, tertiary: 3, unclassified: 2, residential: 2, living_street: 1, service: 0,
};
const SPEED_KMH: Record<string, number> = {
  trunk: 60, primary: 50, secondary: 45, tertiary: 40, unclassified: 35, residential: 30, living_street: 15, service: 20,
};
/** Peak-hour vehicles per km per direction. */
const DENSITY: Record<string, number> = {
  trunk: 42, primary: 36, secondary: 30, tertiary: 24, unclassified: 10, residential: 7, living_street: 3, service: 2.5,
};
const LANE_WIDTH = 3.1;

export class RoadNetwork {
  lanes: Lane[] = [];
  controllers: SignalController[] = [];
  /** Lanes arriving at each node (for yield checks). */
  incoming = new Map<number, number[]>();
  /** Lane ids per road link: [along the link, against it (-1 if one-way)]. */
  linkLanes: [number, number][] = [];

  constructor(readonly file: RoadsFile) {
    const N = file.nodes;
    const boundary = new Set(file.boundary);
    const degree = new Map<number, number>();
    const linksAt = new Map<number, number[]>();
    file.links.forEach((l, i) => {
      for (const end of [l.pts[0], l.pts[l.pts.length - 1]]) {
        degree.set(end, (degree.get(end) ?? 0) + 1);
        linksAt.set(end, [...(linksAt.get(end) ?? []), i]);
      }
    });

    // ---- lanes
    file.links.forEach((l) => {
      const lanesTotal = l.lanes ?? (l.oneway ? 1 : 2);
      const perDir = l.oneway ? lanesTotal : Math.max(1, Math.floor(lanesTotal / 2));
      const offset = l.oneway ? 0 : (perDir * LANE_WIDTH) / 2;
      const make = (pts: number[]): Lane => {
        const poly = offsetPolyline(pts.map((i) => N[i]), offset);
        const cum = new Float64Array(pts.length);
        for (let k = 1; k < pts.length; k++) {
          cum[k] = cum[k - 1] + Math.hypot(poly[k * 3] - poly[k * 3 - 3], poly[k * 3 + 1] - poly[k * 3 - 2]);
        }
        const last = pts.length - 1;
        const speed = (l.maxspeed ?? SPEED_KMH[l.cls] ?? 30) * (l.link ? 0.8 : 1);
        return {
          id: this.lanes.length,
          from: pts[0],
          to: pts[last],
          cls: l.cls,
          rank: RANK[l.cls] ?? 1,
          vmax: speed / 3.6,
          density: (DENSITY[l.cls] ?? 5) * (l.oneway ? Math.min(perDir, 2) : 1),
          pts: poly,
          cum,
          len: cum[last],
          out: [],
          reverse: -1,
          startsAtBoundary: boundary.has(pts[0]),
          endsAtBoundary: boundary.has(pts[last]),
          startsAtDeadEnd: false,
          endsAtDeadEnd: false,
          exitDist: Infinity,
          headStart: Math.atan2(poly[4] - poly[1], poly[3] - poly[0]),
          headEnd: Math.atan2(poly[last * 3 + 1] - poly[last * 3 - 2], poly[last * 3] - poly[last * 3 - 3]),
          signal: null,
          yieldAtEnd: false,
        };
      };
      const fwd = make(l.pts);
      this.lanes.push(fwd);
      this.linkLanes.push([fwd.id, -1]);
      if (!l.oneway) {
        const bwd = make([...l.pts].reverse());
        this.lanes.push(bwd);
        fwd.reverse = bwd.id;
        bwd.reverse = fwd.id;
        this.linkLanes[this.linkLanes.length - 1][1] = bwd.id;
      }
    });

    const startsAt = new Map<number, number[]>();
    for (const ln of this.lanes) {
      startsAt.set(ln.from, [...(startsAt.get(ln.from) ?? []), ln.id]);
      this.incoming.set(ln.to, [...(this.incoming.get(ln.to) ?? []), ln.id]);
    }
    for (const ln of this.lanes) ln.out = startsAt.get(ln.to) ?? [];
    for (const ln of this.lanes) {
      ln.endsAtDeadEnd = !ln.endsAtBoundary && ln.out.every((id) => id === ln.reverse);
      ln.startsAtDeadEnd = !ln.startsAtBoundary && (this.incoming.get(ln.from) ?? []).every((id) => id === ln.reverse);
    }
    // distance to the nearest exit, by relaxing over the lane graph (Bellman-Ford; graph is small)
    for (const ln of this.lanes) if (ln.endsAtBoundary || ln.endsAtDeadEnd) ln.exitDist = ln.len;
    for (let changed = true, iter = 0; changed && iter < this.lanes.length; iter++) {
      changed = false;
      for (const ln of this.lanes) {
        for (const id of ln.out) {
          const d = ln.len + this.lanes[id].exitDist;
          if (d < ln.exitDist) { ln.exitDist = d; changed = true; }
        }
      }
    }

    // ---- traffic lights: cluster signal nodes within 40 m into one controller
    const sig = file.signals;
    const ctrlOf = new Map<number, number>();
    for (const s of sig) {
      if (ctrlOf.has(s)) continue;
      const id = this.controllers.length;
      const queue = [s];
      ctrlOf.set(s, id);
      while (queue.length) {
        const a = queue.pop()!;
        for (const b of sig) {
          if (!ctrlOf.has(b) && Math.hypot(N[a][0] - N[b][0], N[a][1] - N[b][1]) < 40) {
            ctrlOf.set(b, id);
            queue.push(b);
          }
        }
      }
      this.controllers.push({ groups: 1, offset: (id * 23) % 64 });
    }
    const refAxis = new Map<number, number>();
    for (const ln of this.lanes) {
      const ctrl = ctrlOf.get(ln.to);
      if (ctrl === undefined) continue;
      const axis = ((ln.headEnd % Math.PI) + Math.PI) % Math.PI;
      if (!refAxis.has(ctrl)) refAxis.set(ctrl, axis);
      const d = Math.abs(axis - refAxis.get(ctrl)!);
      const group = Math.min(d, Math.PI - d) > Math.PI / 4 ? 1 : 0;
      if (group === 1) this.controllers[ctrl].groups = 2;
      const atJunction = (degree.get(ln.to) ?? 0) >= 3;
      ln.signal = { ctrl, group, stopAt: Math.max(0, ln.len - (atJunction ? 7 : 2)) };
    }

    // ---- give way: minor roads entering a junction with a higher-ranked road (no signal)
    for (const ln of this.lanes) {
      if (ln.signal || (degree.get(ln.to) ?? 0) < 3) continue;
      const others = (linksAt.get(ln.to) ?? []).map((i) => RANK[file.links[i].cls] ?? 1);
      if (Math.max(...others) > ln.rank) ln.yieldAtEnd = true;
    }
  }

  /** Position and heading at distance s along a lane. */
  sample(lane: Lane, s: number): { e: number; n: number; h: number; head: number } {
    const { cum, pts } = lane;
    const x = Math.min(Math.max(s, 0), lane.len);
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= x) lo = mid;
      else hi = mid;
    }
    const seg = cum[hi] - cum[lo] || 1;
    const t = (x - cum[lo]) / seg;
    const a = lo * 3, b = hi * 3;
    return {
      e: pts[a] + (pts[b] - pts[a]) * t,
      n: pts[a + 1] + (pts[b + 1] - pts[a + 1]) * t,
      h: pts[a + 2] + (pts[b + 2] - pts[a + 2]) * t,
      head: Math.atan2(pts[b + 1] - pts[a + 1], pts[b] - pts[a]),
    };
  }
}

/** Offset a polyline to the right of its direction of travel (mitred joins). */
function offsetPolyline(p: [number, number, number][], d: number): Float64Array {
  const out = new Float64Array(p.length * 3);
  // right-hand unit normal of each segment: for direction (dx, dy) it is (dy, -dx)
  const segN: [number, number][] = [];
  for (let k = 0; k < p.length - 1; k++) {
    const dx = p[k + 1][0] - p[k][0], dy = p[k + 1][1] - p[k][1];
    const L = Math.hypot(dx, dy) || 1;
    segN.push([dy / L, -dx / L]);
  }
  for (let k = 0; k < p.length; k++) {
    const n1 = segN[Math.max(0, k - 1)], n2 = segN[Math.min(segN.length - 1, k)];
    let mx = n1[0] + n2[0], my = n1[1] + n2[1];
    const L = Math.hypot(mx, my);
    if (L < 1e-6) { mx = n2[0]; my = n2[1]; } else { mx /= L; my /= L; }
    // mitre length keeps the lane d away from both segments; cap it at sharp corners
    const len = d / Math.max(0.5, mx * n2[0] + my * n2[1]);
    out[k * 3] = p[k][0] + mx * len;
    out[k * 3 + 1] = p[k][1] + my * len;
    out[k * 3 + 2] = p[k][2];
  }
  return out;
}
