import { gradeColor } from "../map/grade";
import type { HeightField } from "../map/heightfield";
import type { FrameUniforms, ViewLike } from "../map/renderer";
import type { RoadNetwork } from "./network";
import type { Car, TrafficSim } from "./sim";

const S2 = Math.SQRT1_2;
const INK = "rgba(42,34,28,0.55)";
const GLASS = "#3a4550";
/** Opacity of a car under tree canopy. */
const TREE_ALPHA = 0.55;

type P2 = [number, number];

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
  /** Parked cars (static 3D objects from pipeline/build_parking.py). */
  private parked: Car[] = [];
  /** Parked cars drawn once into their own layer, redrawn only when the view or light changes. */
  private parkedLayer: HTMLCanvasElement | null = null;
  private parkedKey = "";

  setParkedCars(rows: [number, number, number, number, string | null][]) {
    const palette = ["#f3efe6", "#c9ccd1", "#8e939a", "#2e3136", "#3e5a7e", "#a33f3d", "#e9dcc0", "#5d6e92"];
    this.parked = rows.map(([e, n, h, head, color], i) => ({
      id: -1 - i, lane: -1, s: 0, v: 0, acc: 0, next: -1,
      len: 4.2 + ((i * 37) % 7) / 10, width: 1.8, height: 1.45, kind: "car" as const,
      color: color ?? palette[i % palette.length], drive: 1, presence: 1, leaving: false, parking: false,
      stuck: 0, re: e, rn: n, rh: h, rhead: head, visible: 1, parked: true,
    }));
  }

  constructor(
    private sim: TrafficSim,
    private net: RoadNetwork,
    private view: ViewLike,
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
  private parkedVisibility(c: Car): number {
    if (!this.heights) return 1;
    const cos = Math.cos(c.rhead), sin = Math.sin(c.rhead);
    let vis = 0;
    for (const t of [-0.45, 0, 0.45]) {
      for (const z of [0.4, c.height]) {
        const [x, y] = this.imagePx(c.re + cos * c.len * t, c.rn + sin * c.len * t, c.rh + z);
        const surf = this.heights.at(x, y);
        if (surf === null || surf < c.rh + c.height + 1.2) vis += 1;
        else if (this.heights.solidAt(x, y)) return 0;
        else vis += TREE_ALPHA;
      }
    }
    return vis / 6;
  }

  private shade(hex: string, k: number): string {
    let rgb = this.rgbCache.get(hex);
    if (!rgb) { rgb = hexToRgb(hex); this.rgbCache.set(hex, rgb); }
    const base: [number, number, number] = [(rgb[0] / 255) * k, (rgb[1] / 255) * k, (rgb[2] / 255) * k];
    const [r, g, b] = this.frame ? gradeColor(base, this.frame, this.far) : base;
    return `rgb(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0})`;
  }

  /** @param dt simulated seconds this frame (larger during a timelapse) */
  draw(ctx: CanvasRenderingContext2D, dt: number, frame: FrameUniforms, showMoving = true) {
    this.frame = frame;
    const nightK = frame.nightK;
    const W = this.view.width, H = this.view.height, dpr = this.view.dpr;
    const pxPerM = this.view.scale / this.net.file.mpp;    // device px per metre (horizontal)
    const smooth = 1 - Math.exp(-Math.min(dt, 0.1) * 14);

    const items: { c: Car; y: number }[] = [];
    for (const c of showMoving ? this.sim.cars : []) {
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
    // parked cars never move: draw them into a cached layer and reuse it until the view, size or
    // lighting changes (thousands of cars otherwise get redrawn every frame)
    if (this.parked.length) {
      const q = (v: number) => Math.round(v * 50) / 50;
      const key = [W, H, this.view.off[0].toFixed(2), this.view.off[1].toFixed(2), this.view.scale.toFixed(4),
        q(frame.nightK), q(frame.rain), q(frame.snow), q(frame.smog), this.heights?.loadedCount ?? 0].join("|");
      if (key !== this.parkedKey) {
        this.parkedKey = key;
        this.drawParked(W, H, pxPerM, nightK, lw);
      }
      ctx.drawImage(this.parkedLayer!, 0, 0);
    }
    for (const { c } of items) {
      const alpha = c.presence * c.visible;
      if (alpha < 0.02) continue;
      ctx.globalAlpha = alpha;
      this.far = 1 - this.imagePx(c.re, c.rn, c.rh)[1] / npx;
      this.drawCar(ctx, c, nightK, lw);
    }
    if (nightK > 0.05) {
      ctx.globalCompositeOperation = "lighter";
      for (const { c } of items) {
        const alpha = c.presence * c.visible;
        if (alpha < 0.02 || c.parked) continue;
        this.drawHeadlights(ctx, c, nightK * alpha, pxPerM);
      }
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  private drawParked(W: number, H: number, pxPerM: number, nightK: number, lw: number) {
    if (!this.parkedLayer) this.parkedLayer = document.createElement("canvas");
    const layer = this.parkedLayer;
    if (layer.width !== W || layer.height !== H) { layer.width = W; layer.height = H; }
    const pctx = layer.getContext("2d")!;
    pctx.clearRect(0, 0, W, H);
    const items: { c: Car; y: number }[] = [];
    for (const c of this.parked) {
      const [x, y] = this.proj(c.re, c.rn, c.rh);
      if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
      // a parked car partly behind a building is hidden outright (no ghost over the roof); under
      // trees it is dimmed
      if (pxPerM > 0.6) c.visible = this.parkedVisibility(c);
      items.push({ c, y });
    }
    items.sort((a, b) => a.y - b.y);
    const npx = this.net.file.npx;
    for (const { c } of items) {
      if (c.visible < 0.02) continue;
      pctx.globalAlpha = c.visible;
      this.far = 1 - this.imagePx(c.re, c.rn, c.rh)[1] / npx;
      this.drawCar(pctx, c, nightK, lw);
    }
    pctx.globalAlpha = 1;
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

  private drawCar(ctx: CanvasRenderingContext2D, c: Car, night: number, lw: number) {
    const L = c.len / 2, w = c.width / 2;
    if (this.pxPerM < 0.8) {
      // zoomed out, a car is a few pixels: one roof shape instead of ~6 shaded faces
      const top = this.box(c, -L, L, w, c.height * 0.8, c.height * 0.8).top;
      ctx.fillStyle = this.shade(c.color, 0.9);
      ctx.beginPath();
      top.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
      ctx.closePath();
      ctx.fill();
      return;
    }
    if (c.kind === "van") {
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
    if (!c.parked && (braking || night > 0.3)) {
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
