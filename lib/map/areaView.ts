import type { MapRenderer } from "./renderer";

/** What area-level drawing code needs from the view (canvas size, zoom, projection). */
export interface ViewLike {
  readonly dpr: number;
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  /** Area image px at the canvas origin. */
  readonly off: [number, number];
  /** Area image px -> canvas device px. */
  toCanvas(ix: number, iy: number): [number, number];
}

/**
 * One area inside the world map: its own mosaic pixel coordinates, offset into the world image.
 * Area code (traffic, buildings, landmarks) keeps working in area px; this maps them to the screen.
 */
export class AreaView implements ViewLike {
  constructor(private base: MapRenderer, readonly ox: number, readonly oy: number, readonly size: number) {}

  get dpr() { return this.base.dpr; }
  get scale() { return this.base.scale; }
  get width() { return this.base.width; }
  get height() { return this.base.height; }
  get off(): [number, number] { return [this.base.off[0] - this.ox, this.base.off[1] - this.oy]; }

  toCanvas(ix: number, iy: number): [number, number] {
    return this.base.toCanvas(ix + this.ox, iy + this.oy);
  }

  /** Area image pixel under a CSS-px point, or null if it isn't in this area. */
  imagePixelAt(cssX: number, cssY: number): [number, number] | null {
    const ix = Math.floor(this.base.off[0] + (cssX * this.base.dpr) / this.base.scale - this.ox);
    const iy = Math.floor(this.base.off[1] + (cssY * this.base.dpr) / this.base.scale - this.oy);
    return ix >= 0 && iy >= 0 && ix < this.size && iy < this.size ? [ix, iy] : null;
  }

  /** Is any part of this area on screen? */
  get visible() {
    const [x0, y0] = this.toCanvas(0, 0), [x1, y1] = this.toCanvas(this.size, this.size);
    return x1 > 0 && y1 > 0 && x0 < this.width && y0 < this.height;
  }
}
