import type { ViewLike } from "./renderer";

/**
 * A thin blur layer on top of everything (map, surroundings, cars): nothing under it is changed.
 * Inside the neighbourhood's perimeter (pipeline/perimeter.py) it's clear; from the perimeter
 * outward the blur grows gradually. It's a stack of CSS backdrop-filter layers, each a bit more
 * blurred and masked to start a little further out, so together they blur more the further you get
 * from the perimeter. The masks come from the perimeter's distance map and follow the camera.
 */

/** Blur (Gaussian sigma, metres on the ground) at a distance (metres) outside the perimeter. */
const blurAt = (d: number) => 30 * (1 - Math.exp(-d / 400));   // ~0.075 m more blur per metre at first
/** Each layer fades in between one distance and the next (metres outside the perimeter). */
const STEPS = [0, 20, 50, 90, 140, 200, 280, 380, 500];
/** A single layer's blur is capped (CSS px): large backdrop blurs are slow. */
const MAX_PX = 24;

export interface PerimeterInfo {
  /** Distance map: grey value = metres outside the perimeter (0 inside). */
  file: string;
  /** Image px the distance map covers: x0, y0, x1, y1. */
  rect: [number, number, number, number];
  pad: number;
}

export class PerimeterBlur {
  private layers: { el: HTMLDivElement; metres: number }[] = [];
  private outline: HTMLDivElement | null = null;
  private last = "";

  /**
   * @param container an empty element covering the map, above the canvases
   * @param mpp metres per image px (horizontal)
   * @param showOutline also draw the perimeter (for checking it)
   */
  constructor(private container: HTMLElement, distance: ImageBitmap, private rect: [number, number, number, number],
    private mpp: number, showOutline = false) {
    const w = distance.width, h = distance.height;
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(distance, 0, 0);
    const dist = ctx.getImageData(0, 0, w, h).data;   // R = metres
    // one mask per layer: opaque where the layer applies
    const mask = (alpha: (d: number) => number) => {
      const img = ctx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) {
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
        img.data[i * 4 + 3] = Math.round(255 * alpha(dist[i * 4]));
      }
      ctx.putImageData(img, 0, 0);
      return `url(${cv.toDataURL()})`;
    };
    const smooth = (a: number, b: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    for (let k = 1; k < STEPS.length; k++) {
      const [a, b] = [STEPS[k - 1], STEPS[k]];
      const el = document.createElement("div");
      el.style.cssText = "position:absolute;inset:0;pointer-events:none;mask-repeat:no-repeat;-webkit-mask-repeat:no-repeat";
      const m = mask((d) => smooth(a, b, d));
      el.style.maskImage = m;
      el.style.setProperty("-webkit-mask-image", m);
      container.appendChild(el);
      // stacked blurs add up (as variances): this layer adds what takes the total from blurAt(a) to blurAt(b)
      this.layers.push({ el, metres: Math.sqrt(Math.max(0, blurAt(b) ** 2 - blurAt(a) ** 2)) });
    }
    if (showOutline) {
      const el = document.createElement("div");
      el.style.cssText = "position:absolute;inset:0;pointer-events:none;background:#e3262680;mask-repeat:no-repeat;-webkit-mask-repeat:no-repeat";
      const m = mask((d) => (d >= 1 && d <= 4 ? 1 : 0));
      el.style.maskImage = m;
      el.style.setProperty("-webkit-mask-image", m);
      container.appendChild(el);
      this.outline = el;
    }
  }

  /** Follow the camera (call every frame; does nothing if the view hasn't changed). */
  update(view: ViewLike) {
    const [x0, y0, x1, y1] = this.rect;
    const k = view.scale / view.dpr;                       // CSS px per image px
    const pos = `${((x0 - view.off[0]) * k).toFixed(1)}px ${((y0 - view.off[1]) * k).toFixed(1)}px`;
    const size = `${((x1 - x0) * k).toFixed(1)}px ${((y1 - y0) * k).toFixed(1)}px`;
    const key = pos + size;
    if (key === this.last) return;
    this.last = key;
    const metresPerPx = this.mpp / k;
    for (const el of [...this.layers.map((l) => l.el), ...(this.outline ? [this.outline] : [])]) {
      el.style.maskPosition = pos;
      el.style.maskSize = size;
      el.style.setProperty("-webkit-mask-position", pos);
      el.style.setProperty("-webkit-mask-size", size);
    }
    for (const { el, metres } of this.layers) {
      const px = Math.min(MAX_PX, metres / metresPerPx);
      const f = px < 0.3 ? "none" : `blur(${px.toFixed(1)}px)`;
      if (el.style.backdropFilter !== f) {
        el.style.backdropFilter = f;
        el.style.setProperty("-webkit-backdrop-filter", f);
      }
    }
  }

  dispose() {
    this.container.replaceChildren();
  }
}
