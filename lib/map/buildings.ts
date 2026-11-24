import type { Building, BuildingsFile } from "../types";
import type { ViewLike } from "./areaView";
import type { TiledData } from "./tiles";

const S2 = Math.SQRT1_2;

/**
 * Exact camera: orthographic, heading 45°, pitch -45°.
 * Local (east, north, height) metres -> mosaic image pixel.
 */
export function projectToImage(file: BuildingsFile, e: number, n: number, h: number): [number, number] {
  const c = file.npx / 2;
  return [c + (S2 * e - S2 * n) / file.mpp, c - (0.5 * e + 0.5 * n + S2 * h) / file.mpp];
}

/** Building index map tiles (id = R + 256·G, 0 = none), loaded on demand for CPU picking. */
export class BuildingPicker {
  constructor(readonly tiles: TiledData) {}

  /** Building id under a mosaic pixel (0 = none, or its tile hasn't loaded yet). */
  at(ix: number, iy: number): number {
    const p = this.tiles.rgb(ix, iy);
    return p ? p[0] + p[1] * 256 : 0;
  }
}

/** Indices of footprint vertices on the 2D convex hull (where vertical edges are drawn). */
function hullCorners(pts: [number, number, number][]): Set<number> {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: typeof p = [], hi: typeof p = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (const q of p.reverse()) {
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop();
    hi.push(q);
  }
  return new Set(lo.concat(hi).map((q) => q[2]));
}

/** Draws hover/selection boxes (straight lines + flat fills only) on a 2D overlay canvas. */
export class BuildingOverlay {
  private scratch = document.createElement("canvas");
  private sctx = this.scratch.getContext("2d")!;
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement, private file: BuildingsFile, private view: ViewLike) {
    this.ctx = canvas.getContext("2d")!;
  }

  resize() {
    this.canvas.width = this.view.width;
    this.canvas.height = this.view.height;
  }

  private box(b: Building) {
    const top = Math.max(b.roof_main ?? b.roof, b.ground + 2);
    const p = (e: number, n: number, h: number) => this.view.toCanvas(...projectToImage(this.file, e, n, h));
    return { base: b.fp.map(([e, n]) => p(e, n, b.ground)), roof: b.fp.map(([e, n]) => p(e, n, top)) };
  }

  /** Roof + every wall quad painted opaque offscreen, then composited once (no alpha stacking). */
  private fill(b: Building, alpha: number) {
    const { base, roof } = this.box(b);
    const { scratch: fx, sctx: f } = this;
    if (fx.width !== this.canvas.width || fx.height !== this.canvas.height) {
      fx.width = this.canvas.width;
      fx.height = this.canvas.height;
    }
    f.clearRect(0, 0, fx.width, fx.height);
    f.fillStyle = "#fff";
    f.beginPath();
    roof.forEach(([x, y], i) => (i ? f.lineTo(x, y) : f.moveTo(x, y)));
    f.closePath();
    f.fill();
    for (let i = 0; i < base.length - 1; i++) {
      f.beginPath();
      f.moveTo(...base[i]);
      f.lineTo(...base[i + 1]);
      f.lineTo(...roof[i + 1]);
      f.lineTo(...roof[i]);
      f.closePath();
      f.fill();
    }
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(fx, 0, 0);
    this.ctx.globalAlpha = 1;
  }

  /** Draw on top of whatever is already on the overlay (the caller clears it each frame). */
  draw(selected: number, hovered: number) {
    const { ctx } = this;
    const dpr = this.view.dpr;
    const B = this.file.buildings;
    if (hovered && hovered !== selected && B[hovered - 1]) this.fill(B[hovered - 1], 0.1);
    const b = selected ? B[selected - 1] : undefined;
    if (!b) return;
    const { base, roof } = this.box(b);
    this.fill(b, 0.14);
    ctx.lineJoin = "miter";
    ctx.lineCap = "butt";
    // dashed base
    ctx.strokeStyle = "rgba(255,255,255,.85)";
    ctx.lineWidth = 1.2 * dpr;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath();
    base.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    // vertical edges at the outer corners
    ctx.setLineDash([]);
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = "#fff";
    const corners = hullCorners(b.fp.slice(0, -1).map(([e, n], i) => [e, n, i]));
    ctx.beginPath();
    for (const i of corners) {
      ctx.moveTo(...base[i]);
      ctx.lineTo(...roof[i]);
    }
    ctx.stroke();
    // roof outline
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    roof.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
  }
}
