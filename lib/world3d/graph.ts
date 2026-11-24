import type { Pt } from "./types";

/**
 * A routable network built from OSM polylines: nodes where ways meet (shared OSM nodes have the
 * same coordinates) or end; edges are the polylines between them; lanes are an edge in one
 * direction, offset to the right-hand side (Kosovo drives on the right).
 */
export interface Edge {
  from: number;
  to: number;
  pts: Pt[];
  cum: number[];
  length: number;
  width: number;
  kind: string;
  name?: string;
  oneway: boolean;
  speed: number;
}

export interface Lane {
  id: number;
  edge: number;
  dir: 1 | -1;
  from: number;
  to: number;
  offset: number;
  length: number;
  speed: number;
}

export interface GNode {
  x: number;
  y: number;
  out: number[];
  in: number[];
  /** distinct neighbouring nodes (junction if >= 3) */
  degree: number;
  boundary: boolean;
}

export interface SourceLine {
  pts: Pt[];
  width: number;
  kind: string;
  name?: string;
  oneway: boolean;
  speed: number;
}

export class Graph {
  readonly nodes: GNode[] = [];
  readonly edges: Edge[] = [];
  readonly lanes: Lane[] = [];

  constructor(lines: SourceLine[], half: number, laneOffset: (e: Edge) => number) {
    const key = (p: Pt) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    const count = new Map<string, number>();
    for (const l of lines) for (const p of l.pts) count.set(key(p), (count.get(key(p)) ?? 0) + 1);
    const nodeOf = new Map<string, number>();
    const node = (p: Pt) => {
      const k = key(p);
      let i = nodeOf.get(k);
      if (i === undefined) {
        i = this.nodes.push({
          x: p[0], y: p[1], out: [], in: [], degree: 0,
          boundary: Math.abs(p[0]) > half - 3 || Math.abs(p[1]) > half - 3,
        }) - 1;
        nodeOf.set(k, i);
      }
      return i;
    };
    for (const l of lines) {
      let start = 0;
      for (let k = 1; k < l.pts.length; k++) {
        const isNode = k === l.pts.length - 1 || (count.get(key(l.pts[k])) ?? 0) > 1;
        if (!isNode) continue;
        const pts = l.pts.slice(start, k + 1);
        start = k;
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
        const length = cum[cum.length - 1];
        if (length < 0.5) continue;
        this.edges.push({
          from: node(pts[0]), to: node(pts[pts.length - 1]), pts, cum, length,
          width: l.width, kind: l.kind, name: l.name, oneway: l.oneway, speed: l.speed,
        });
      }
    }
    const nb = this.nodes.map(() => new Set<number>());
    this.edges.forEach((e, ei) => {
      nb[e.from].add(e.to);
      nb[e.to].add(e.from);
      const off = laneOffset(e);
      const add = (dir: 1 | -1) => {
        const lane: Lane = {
          id: this.lanes.length, edge: ei, dir,
          from: dir > 0 ? e.from : e.to, to: dir > 0 ? e.to : e.from,
          offset: off, length: e.length, speed: e.speed,
        };
        this.lanes.push(lane);
        this.nodes[lane.from].out.push(lane.id);
        this.nodes[lane.to].in.push(lane.id);
      };
      add(1);
      if (!e.oneway) add(-1);
    });
    this.nodes.forEach((n, i) => { n.degree = nb[i].size; });
  }

  /** The lane of the same edge in the other direction, if any. */
  reverse(lane: Lane): Lane | undefined {
    return this.lanes.find((l) => l.edge === lane.edge && l.dir !== lane.dir);
  }

  /** Position (x, y), heading (rad, 0 = east, CCW) at distance s along a lane, on its right-hand offset. */
  at(lane: Lane, s: number, out: { x: number; y: number; h: number }) {
    const e = this.edges[lane.edge];
    const d = lane.dir > 0 ? s : e.length - s;
    const cum = e.cum;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const a = e.pts[i - 1], b = e.pts[i];
    const segL = cum[i] - cum[i - 1] || 1;
    const t = Math.max(0, Math.min(1, (d - cum[i - 1]) / segL));
    let dx = (b[0] - a[0]) / segL, dy = (b[1] - a[1]) / segL;
    if (lane.dir < 0) { dx = -dx; dy = -dy; }
    out.x = a[0] + (b[0] - a[0]) * t + dy * lane.offset;
    out.y = a[1] + (b[1] - a[1]) * t - dx * lane.offset;
    out.h = Math.atan2(dy, dx);
    return out;
  }

  /** Heading change (rad, 0..π) going from the end of lane a into lane b. */
  turnAngle(a: Lane, b: Lane) {
    const p = { x: 0, y: 0, h: 0 }, q = { x: 0, y: 0, h: 0 };
    this.at(a, Math.max(0, a.length - 0.5), p);
    this.at(b, Math.min(b.length, 0.5), q);
    let d = Math.abs(q.h - p.h) % (2 * Math.PI);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  }

  /** Nearest edge to a point within maxD metres. */
  nearestEdge(x: number, y: number, maxD: number): { edge: Edge; d: number } | null {
    let best: { edge: Edge; d: number } | null = null;
    for (const e of this.edges) {
      for (let i = 1; i < e.pts.length; i++) {
        const [ax, ay] = e.pts[i - 1], [bx, by] = e.pts[i];
        const ex = bx - ax, ey = by - ay;
        const L2 = ex * ex + ey * ey || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / L2));
        const d = Math.hypot(x - ax - ex * t, y - ay - ey * t);
        if (d < maxD && (!best || d < best.d)) best = { edge: e, d };
      }
    }
    return best;
  }
}
