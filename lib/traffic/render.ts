import { gradeColor } from "../map/grade";
import type { HeightField } from "../map/heightfield";
import type { FrameUniforms, MapRenderer } from "../map/renderer";
import type { RoadNetwork } from "./network";
import type { Car, TrafficSim } from "./sim";

const S2 = Math.SQRT1_2;
const INK = "rgba(42,34,28,0.55)";
const GLASS = "#3a4550";
/** Trafiku Urban buses are yellow. */
const BUS_BODY = "#e7b32f";
/** Opacity of a car under tree canopy. */
const TREE_ALPHA = 0.55;

type P2 = [number, number];

/** A bus line's path through the map, highlighted when one of its buses is selected. */
export interface RouteHighlight {
  lanes: number[];
  laneStart: number[];
  stops: { name: string; at: number }[];
  color: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Draws simulated cars as small shaded boxes in the map's exact orthographic view. */
export class TrafficRenderer {
  private rgbCache = new Map<string, [number, number, number]>();
  private frame: FrameUniforms | null = null;
  private far = 0.5;
  private pxPerM = 1;
  /** Selected bus and the route to highlight under it. */
  private selection: { carId: number; route: RouteHighlight | null } | null = null;

  setSelection(carId: number | null, route: RouteHighlight | null) {
    this.selection = carId ? { carId, route } : null;
  }

  /** Screen hull (device px) of a car's box, for picking. */
  private hull(c: Car): P2[] {
    const b = this.box(c, -c.len / 2, c.len / 2, c.width / 2, 0, c.height);
    return convexHull([...b.base, ...b.top]);
  }

  /** The bus under a point (CSS px), if any. */
  pickBus(cssX: number, cssY: number): Car | null {
    const x = cssX * this.view.dpr, y = cssY * this.view.dpr, pad = 6 * this.view.dpr;
    let best: Car | null = null, bestD = Infinity;
    for (const c of this.sim.cars) {
      if (c.kind !== "bus" || c.presence * c.visible < 0.2) continue;
      const h = this.hull(c);
      const [cx, cy] = this.proj(c.re, c.rn, c.rh + c.height / 2);
      const d = Math.hypot(cx - x, cy - y);
      if ((insideConvex(h, x, y) || d < pad + 4 * this.view.dpr) && d < bestD) { best = c; bestD = d; }
    }
    return best;
  }

  constructor(
    private sim: TrafficSim,
    private net: RoadNetwork,
    private view: MapRenderer,
    private heights: HeightField | null,
  ) {
    // spawn / despawn only where nobody is looking (outside the viewport or the illustration)
    sim.setViewProbe((e, n, h) => this.onScreen(e, n, h));
  }

  /** Is a ground point inside the drawn illustration and within the current viewport (+ margin)? */
  onScreen(e: number, n: number, h: number, marginPx = 80): boolean {
    const [ix, iy] = this.imagePx(e, n, h);
    const npx = this.net.file.npx, pad = 60;   // a car's length past the drawn edge still counts as visible
    if (ix < -pad || iy < -pad || ix >= npx + pad || iy >= npx + pad) return false;
    const [x, y] = this.view.toCanvas(ix, iy);
    const m = marginPx * this.view.dpr;
    return x > -m && y > -m && x < this.view.width + m && y < this.view.height + m;
  }

  /** local (e, n, h) metres -> canvas device px */
  private proj(e: number, n: number, h: number): P2 {
    const c = this.net.file.npx / 2, m = this.net.file.mpp;
    return this.view.toCanvas(c + (S2 * e - S2 * n) / m, c - (0.5 * e + 0.5 * n + S2 * h) / m);
  }

  private imagePx(e: number, n: number, h: number): P2 {
    const c = this.net.file.npx / 2, m = this.net.file.mpp;
    return [c + (S2 * e - S2 * n) / m, c - (0.5 * e + 0.5 * n + S2 * h) / m];
  }

  /**
   * How much of the car shows: buildings and bridge / passage decks in front of it hide it,
   * tree canopy only dims it (so cars don't vanish for a whole tree-lined block).
   */
  private visibility(c: Car): number {
    if (!this.heights) return 1;
    const cos = Math.cos(c.rhead), sin = Math.sin(c.rhead);
    let vis = 0;
    for (const t of [-0.4, 0, 0.4]) {
      const e = c.re + cos * c.len * t, n = c.rn + sin * c.len * t;
      const [x, y] = this.imagePx(e, n, c.rh + c.height * 0.7);
      const surf = this.heights.at(x, y);
      if (surf === null || surf < c.rh + c.height + 1.2) vis += 1;
      else if (!this.heights.solidAt(x, y)) vis += TREE_ALPHA;
    }
    return vis / 3;
  }

  /** Car paint with face shading `k`, graded like the map underneath (sun, weather, smog). */
  private shade(hex: string, k: number): string {
    let rgb = this.rgbCache.get(hex);
    if (!rgb) { rgb = hexToRgb(hex); this.rgbCache.set(hex, rgb); }
    const base: [number, number, number] = [(rgb[0] / 255) * k, (rgb[1] / 255) * k, (rgb[2] / 255) * k];
    const [r, g, b] = this.frame ? gradeColor(base, this.frame, this.far) : base;
    return `rgb(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0})`;
  }

  /** @param dt simulated seconds this frame (larger during a timelapse) */
  draw(ctx: CanvasRenderingContext2D, dt: number, frame: FrameUniforms) {
    this.frame = frame;
    const nightK = frame.nightK;
    const W = this.view.width, H = this.view.height, dpr = this.view.dpr;
    const pxPerM = this.view.scale / this.net.file.mpp;    // device px per metre (horizontal)
    const smooth = 1 - Math.exp(-Math.min(dt, 0.1) * 14);

    const items: { c: Car; y: number }[] = [];
    for (const c of this.sim.cars) {
      const ln = this.net.lanes[c.lane];
      const p = this.net.sample(ln, c.s);
      // smooth position/heading so lane changes at junctions glide instead of jumping
      const far = Math.hypot(p.e - c.re, p.n - c.rn) > 8;
      c.re = far ? p.e : c.re + (p.e - c.re) * smooth;
      c.rn = far ? p.n : c.rn + (p.n - c.rn) * smooth;
      c.rh = far ? p.h : c.rh + (p.h - c.rh) * smooth;
      let dh = p.head - c.rhead;
      if (dh > Math.PI) dh -= 2 * Math.PI;
      if (dh < -Math.PI) dh += 2 * Math.PI;
      c.rhead = far ? p.head : c.rhead + dh * smooth;
      // occlusion needs height tiles under every car; zoomed far out cars are a pixel or two, so
      // skip it there (keeps a big map from loading every height tile at the overview zoom)
      if (pxPerM > 0.6) c.visible += (this.visibility(c) - c.visible) * Math.min(1, smooth * 1.5);
      const [x, y] = this.proj(c.re, c.rn, c.rh);
      if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
      items.push({ c, y });
    }
    items.sort((a, b) => a.y - b.y);   // far (top of screen) first

    const lw = Math.max(0.5, Math.min(1.2, pxPerM * 0.12)) * Math.min(dpr, 1.5);
    this.pxPerM = pxPerM;
    // cars are simulated a little beyond the illustration; only draw them over the map itself
    const [cx0, cy0] = this.view.toCanvas(0, 0);
    const [cx1, cy1] = this.view.toCanvas(this.net.file.npx, this.net.file.npx);
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx0, cy0, cx1 - cx0, cy1 - cy0);
    ctx.clip();
    const npx = this.net.file.npx;
    if (this.selection?.route) this.drawRoute(ctx, this.selection.route, dpr);
    for (const { c } of items) {
      const alpha = c.presence * c.visible;
      if (alpha < 0.02) continue;
      ctx.globalAlpha = alpha;
      this.far = 1 - this.imagePx(c.re, c.rn, c.rh)[1] / npx;
      this.drawCar(ctx, c, nightK, lw);
      if (this.selection?.carId === c.id) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2.5 * dpr;
        ctx.beginPath();
        this.hull(c).forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
        ctx.closePath();
        ctx.stroke();
      }
    }
    if (nightK > 0.05) {
      ctx.globalCompositeOperation = "lighter";
      for (const { c } of items) {
        const alpha = c.presence * c.visible;
        if (alpha < 0.02) continue;
        this.drawHeadlights(ctx, c, nightK * alpha, pxPerM);
      }
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  private box(c: Car, x0: number, x1: number, w: number, z0: number, z1: number): { base: P2[]; top: P2[]; normals: P2[] } {
    const cos = Math.cos(c.rhead), sin = Math.sin(c.rhead);
    const corners: P2[] = [[x0, -w], [x1, -w], [x1, w], [x0, w]];
    const ground = corners.map(([a, b]) => [c.re + cos * a - sin * b, c.rn + sin * a + cos * b] as P2);
    const base = ground.map(([e, n]) => this.proj(e, n, c.rh + z0));
    const top = ground.map(([e, n]) => this.proj(e, n, c.rh + z1));
    // outward normals of faces 0-1 (right side), 1-2 (front), 2-3 (left side), 3-0 (rear)
    const normals: P2[] = [[sin, -cos], [cos, sin], [-sin, cos], [-cos, -sin]];
    return { base, top, normals };
  }

  private faces(ctx: CanvasRenderingContext2D, b: ReturnType<TrafficRenderer["box"]>, side: string, sideDark: string, topFill: string, lw: number) {
    // camera looks north-east, so faces whose normal points south-west (e + n < 0) are visible
    ctx.lineWidth = lw;
    ctx.strokeStyle = INK;
    for (let i = 0; i < 4; i++) {
      const [ne, nn] = b.normals[i];
      if (ne + nn >= 0) continue;
      const j = (i + 1) % 4;
      ctx.fillStyle = nn < ne ? sideDark : side;   // south-facing faces a touch darker
      ctx.beginPath();
      ctx.moveTo(...b.base[i]); ctx.lineTo(...b.base[j]); ctx.lineTo(...b.top[j]); ctx.lineTo(...b.top[i]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = topFill;
    ctx.beginPath();
    b.top.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  /** The selected bus's line through the map, with its stops. */
  private drawRoute(ctx: CanvasRenderingContext2D, r: RouteHighlight, dpr: number) {
    const width = Math.max(3 * dpr, Math.min(10 * dpr, this.pxPerM * 3));
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = width;
    ctx.beginPath();
    let first = true;
    for (const id of r.lanes) {
      const ln = this.net.lanes[id];
      for (let k = 0; k < ln.pts.length / 3; k++) {
        const [x, y] = this.proj(ln.pts[k * 3], ln.pts[k * 3 + 1], ln.pts[k * 3 + 2]);
        if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    const fs = Math.round(11 * dpr);
    ctx.font = `600 ${fs}px -apple-system, system-ui, sans-serif`;
    for (const st of r.stops) {
      let i = 0;
      while (i + 1 < r.lanes.length && r.laneStart[i + 1] <= st.at) i++;
      const ln = this.net.lanes[r.lanes[i]];
      const p = this.net.sample(ln, st.at - r.laneStart[i]);
      const [x, y] = this.proj(p.e, p.n, p.h);
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 3 * dpr;
      ctx.beginPath();
      ctx.arc(x, y, 5 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const label = st.name;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(43,39,36,.85)";
      ctx.fillRect(x + 8 * dpr, y - fs * 0.9, tw + 8 * dpr, fs * 1.5);
      ctx.fillStyle = "#f3ece0";
      ctx.fillText(label, x + 12 * dpr, y + fs * 0.25);
    }
    ctx.restore();
  }

  private drawBus(ctx: CanvasRenderingContext2D, c: Car, lw: number) {
    const L = c.len / 2, w = c.width / 2;
    const body = this.shade(BUS_BODY, 0.85), bodyDark = this.shade(BUS_BODY, 0.72), roof = this.shade(BUS_BODY, 1);
    this.faces(ctx, this.box(c, -L, L, w, 0.3, 1.15), body, bodyDark, roof, lw);
    this.faces(ctx, this.box(c, -L + 0.3, L - 0.15, w * 0.98, 1.15, c.height - 0.25), this.shade(GLASS, 1), this.shade(GLASS, 0.85), roof, lw);
    this.faces(ctx, this.box(c, -L + 0.3, L - 0.15, w * 0.98, c.height - 0.25, c.height), body, bodyDark, roof, lw);
    // line colour stripe along the roof
    const stripe = this.box(c, -L * 0.8, L * 0.8, w * 0.35, c.height, c.height + 0.02);
    ctx.fillStyle = this.shade(c.color, 1);
    ctx.beginPath();
    stripe.top.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
    ctx.closePath();
    ctx.fill();
    // line number on the roof when zoomed in enough to read it
    const ref = c.label;
    if (ref && this.pxPerM > 2.2) {
      const [x, y] = this.proj(c.re, c.rn, c.rh + c.height + 0.05);
      const fs = Math.min(28, this.pxPerM * 1.7);
      ctx.font = `700 ${fs}px -apple-system, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = this.shade(c.color, 0.8);
      ctx.lineWidth = Math.max(2, fs / 6);
      ctx.strokeText(ref, x, y);
      ctx.fillText(ref, x, y);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }
  }

  private drawCar(ctx: CanvasRenderingContext2D, c: Car, night: number, lw: number) {
    const L = c.len / 2, w = c.width / 2;
    if (c.kind === "bus") {
      this.drawBus(ctx, c, lw);
    } else if (c.kind === "van") {
      this.faces(ctx, this.box(c, -L, L, w, 0.25, c.height), this.shade(c.color, 0.8), this.shade(c.color, 0.7), this.shade(c.color, 1), lw);
      // windscreen strip on the roof's front edge
      const ws = this.box(c, L - 0.5, L, w * 0.9, c.height - 0.02, c.height);
      this.faces(ctx, ws, this.shade(GLASS, 1), this.shade(GLASS, 0.9), this.shade(GLASS, 1.1), lw * 0.5);
    } else {
      this.faces(ctx, this.box(c, -L, L, w, 0.25, 0.85), this.shade(c.color, 0.8), this.shade(c.color, 0.7), this.shade(c.color, 1), lw);
      // cabin: glass sides, painted roof, set back from the bonnet
      this.faces(ctx, this.box(c, -L * 0.62, L * 0.32, w * 0.86, 0.85, c.height), this.shade(GLASS, 1), this.shade(GLASS, 0.85), this.shade(c.color, 0.95), lw);
    }
    // brake / tail lights
    const braking = c.acc < -1.2 && c.v > 0.3;
    if (braking || night > 0.3) {
      const cos = Math.cos(c.rhead), sin = Math.sin(c.rhead);
      ctx.fillStyle = braking ? "#ff3b2f" : "#c8352b";
      for (const side of [-1, 1]) {
        const e = c.re - cos * L + -sin * side * w * 0.75, n = c.rn - sin * L + cos * side * w * 0.75;
        const [x, y] = this.proj(e, n, c.rh + 0.65);
        const r = Math.max(0.8, lw * 1.3);
        ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
      }
    }
  }

  private drawHeadlights(ctx: CanvasRenderingContext2D, c: Car, k: number, pxPerM: number) {
    const cos = Math.cos(c.rhead), sin = Math.sin(c.rhead);
    const L = c.len / 2;
    const [x0, y0] = this.proj(c.re + cos * L, c.rn + sin * L, c.rh);
    const reach = 11;
    const [x1, y1] = this.proj(c.re + cos * (L + reach), c.rn + sin * (L + reach), c.rh);
    const g = ctx.createRadialGradient(x0, y0, 0, x0, y0, Math.hypot(x1 - x0, y1 - y0) || 1);
    g.addColorStop(0, `rgba(255,232,180,${0.42 * k})`);
    g.addColorStop(1, "rgba(255,232,180,0)");
    ctx.fillStyle = g;
    const spread = 3.2;
    const a = this.proj(c.re + cos * L - sin * 0.8, c.rn + sin * L + cos * 0.8, c.rh);
    const b = this.proj(c.re + cos * L + sin * 0.8, c.rn + sin * L - cos * 0.8, c.rh);
    const d1 = this.proj(c.re + cos * (L + reach) + sin * spread, c.rn + sin * (L + reach) - cos * spread, c.rh);
    const d2 = this.proj(c.re + cos * (L + reach) - sin * spread, c.rn + sin * (L + reach) + cos * spread, c.rh);
    ctx.beginPath();
    ctx.moveTo(...a); ctx.lineTo(...b); ctx.lineTo(...d1); ctx.lineTo(...d2);
    ctx.closePath();
    ctx.fill();
    // the lamps themselves
    ctx.fillStyle = `rgba(255,244,214,${0.9 * k})`;
    const r = Math.max(0.9, pxPerM * 0.25);
    for (const side of [-1, 1]) {
      const [x, y] = this.proj(c.re + cos * L - sin * side * 0.65, c.rn + sin * L + cos * side * 0.65, c.rh + 0.6);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function convexHull(pts: P2[]): P2[] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: P2[] = [], hi: P2[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

function insideConvex(h: P2[], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < h.length; i++) {
    const [ax, ay] = h[i], [bx, by] = h[(i + 1) % h.length];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c !== 0) {
      if (sign === 0) sign = Math.sign(c);
      else if (Math.sign(c) !== sign) return false;
    }
  }
  return true;
}
