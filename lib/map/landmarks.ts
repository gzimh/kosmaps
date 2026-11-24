import type { ViewLike } from "./areaView";

/** public/data/landmarks.json (curated in pipeline/landmarks.json, positioned by export_web.py). */
export interface Landmark {
  id: string;
  name: string;
  local?: string;
  kind: string;
  summary: string;
  links: { title: string; url: string; lang: string }[];
  /** Clickable building this landmark is, if any (index into buildings.json, 1-based). */
  building?: number;
  e: number;
  n: number;
  h: number;
}

export interface LandmarksFile {
  about?: string;
  landmarks: Landmark[];
}

const S2 = Math.SQRT1_2;

/** Map labels for landmarks: small pins with names, drawn on the 2D overlay and clickable. */
export class LandmarkLayer {
  private boxes: { lm: Landmark; x0: number; y0: number; x1: number; y1: number }[] = [];

  constructor(readonly file: LandmarksFile, private view: ViewLike, private npx: number, private mpp: number) {}

  private screen(lm: Landmark): [number, number] {
    const c = this.npx / 2;
    const ix = c + (S2 * lm.e - S2 * lm.n) / this.mpp;
    const iy = c - (0.5 * lm.e + 0.5 * lm.n + S2 * lm.h) / this.mpp;
    return this.view.toCanvas(ix, iy);
  }

  draw(ctx: CanvasRenderingContext2D, selectedId: string | null, hoverId: string | null, night: number) {
    const dpr = this.view.dpr;
    const W = this.view.width, H = this.view.height;
    const fs = Math.round(11.5 * dpr);
    const pad = 5 * dpr, pinR = 4 * dpr, lift = 14 * dpr;
    ctx.save();
    ctx.font = `600 ${fs}px -apple-system, system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    this.boxes = [];
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    // selected / hovered first so they always get their label; then the rest, nearest the bottom first
    const order = this.file.landmarks
      .map((lm) => ({ lm, p: this.screen(lm) }))
      .filter(({ p: [x, y] }) => x > -60 && y > -60 && x < W + 60 && y < H + 60)
      .sort((a, b) => Number(b.lm.id === selectedId) - Number(a.lm.id === selectedId) || Number(b.lm.id === hoverId) - Number(a.lm.id === hoverId) || b.p[1] - a.p[1]);
    for (const { lm, p: [x, y] } of order) {
      const active = lm.id === selectedId || lm.id === hoverId;
      const label = lm.name;
      const tw = ctx.measureText(label).width;
      const bx0 = x - tw / 2 - pad - pinR, bx1 = x + tw / 2 + pad + pinR;
      const by0 = y - lift - fs * 0.8, by1 = y - lift + fs * 0.8;
      const overlaps = placed.some((q) => bx0 < q.x1 && bx1 > q.x0 && by0 < q.y1 && by1 > q.y0);
      // stem + anchor dot
      ctx.strokeStyle = night > 0.5 ? "rgba(255,240,215,.8)" : "rgba(43,39,36,.75)";
      ctx.lineWidth = 1.2 * dpr;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, overlaps && !active ? y - 6 * dpr : by1);
      ctx.stroke();
      ctx.fillStyle = "#e07a5f";
      ctx.beginPath();
      ctx.arc(x, y, 2.6 * dpr, 0, Math.PI * 2);
      ctx.fill();
      if (overlaps && !active) {
        // no room for the name: a small pin you can still click
        this.boxes.push({ lm, x0: x - 8 * dpr, y0: y - 10 * dpr, x1: x + 8 * dpr, y1: y + 6 * dpr });
        continue;
      }
      placed.push({ x0: bx0, y0: by0, x1: bx1, y1: by1 });
      ctx.fillStyle = active ? "#2b2724" : "rgba(43,39,36,.86)";
      ctx.beginPath();
      ctx.roundRect(bx0, by0, bx1 - bx0, by1 - by0, (by1 - by0) / 2);
      ctx.fill();
      if (active) {
        ctx.strokeStyle = "#e07a5f";
        ctx.lineWidth = 1.5 * dpr;
        ctx.stroke();
      }
      ctx.fillStyle = "#e07a5f";
      ctx.beginPath();
      ctx.arc(bx0 + pad + pinR / 2 + 1, (by0 + by1) / 2, pinR / 1.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#f3ece0";
      ctx.fillText(label, bx0 + pad + pinR * 1.6 + 2, (by0 + by1) / 2 + 0.5);
      this.boxes.push({ lm, x0: bx0, y0: by0, x1: bx1, y1: by1 });
    }
    ctx.restore();
  }

  /** Landmark label under a point (CSS px), using the last drawn frame. */
  pick(cssX: number, cssY: number): Landmark | null {
    const x = cssX * this.view.dpr, y = cssY * this.view.dpr;
    for (let i = this.boxes.length - 1; i >= 0; i--) {
      const b = this.boxes[i];
      if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return b.lm;
    }
    return null;
  }

  forBuilding(buildingId: number): Landmark | null {
    return this.file.landmarks.find((l) => l.building === buildingId) ?? null;
  }
}
