/**
 * Tile loading: decoded off the main thread with createImageBitmap, a few at a time, most urgent
 * first. Requests that stop being wanted (the view moved on) are dropped before they start.
 */
export class TileLoader {
  private queue = new Map<string, { url: string; priority: number; wantedAt: number; resolve: (b: ImageBitmap | null) => void }>();
  private inFlight = 0;
  private frame = 0;
  /** Bytes downloaded so far (for diagnostics). */
  bytes = 0;
  loaded = 0;

  constructor(private concurrency = 6) {}

  /** Call once per frame; requests not renewed for a few frames are dropped from the queue. */
  tick() {
    this.frame++;
    for (const [key, q] of this.queue) {
      if (this.frame - q.wantedAt > 30) {
        this.queue.delete(key);
        q.resolve(null);
      }
    }
    this.pump();
  }

  /**
   * Ask for a tile (lower priority value = sooner). Re-requesting one that is queued renews and
   * re-prioritises it (returns null); callers must not re-request tiles already downloading.
   */
  request(key: string, url: string, priority: number): Promise<ImageBitmap | null> | null {
    const q = this.queue.get(key);
    if (q) {
      q.priority = priority;
      q.wantedAt = this.frame;
      return null;
    }
    if (!url) return null;   // renewal of a tile that is already downloading
    return new Promise((resolve) => {
      this.queue.set(key, { url, priority, wantedAt: this.frame, resolve });
      this.pump();
    });
  }

  private pump() {
    while (this.inFlight < this.concurrency && this.queue.size) {
      let bestKey = "", best = Infinity;
      for (const [k, q] of this.queue) if (q.priority < best) { best = q.priority; bestKey = k; }
      const q = this.queue.get(bestKey)!;
      this.queue.delete(bestKey);
      this.inFlight++;
      fetch(q.url)
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`${r.status} ${q.url}`))))
        .then((blob) => {
          this.bytes += blob.size;
          return createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        })
        .then((bmp) => { this.loaded++; q.resolve(bmp); })
        .catch(() => q.resolve(null))
        .finally(() => { this.inFlight--; this.pump(); });
    }
  }
}

export interface DataTileInfo {
  /** Tile size in the layer's own pixels. */
  tile: number;
  /** Layer pixels per mosaic pixel. */
  factor: number;
  cols: number;
  rows: number;
}

/**
 * A CPU-side raster split into tiles (lossless PNG), loaded on demand. `rgb()` returns null for a
 * pixel whose tile isn't loaded yet and asks for it, so callers just try again next frame.
 */
export class TiledData {
  private tiles = new Map<number, { d: Uint8ClampedArray; w: number; h: number } | null>();   // null = loading
  /** Number of tiles loaded so far (lets callers notice new data arriving). */
  loadedCount = 0;

  constructor(private loader: TileLoader, private baseUrl: string, private info: DataTileInfo) {}

  private key(tx: number, ty: number) {
    return ty * this.info.cols + tx;
  }

  private ensure(tx: number, ty: number, priority: number) {
    const k = this.key(tx, ty);
    if (this.tiles.has(k)) return;
    this.tiles.set(k, null);
    const p = this.loader.request(`${this.baseUrl}/${tx}_${ty}`, `${this.baseUrl}/${tx}_${ty}.png`, priority);
    p?.then((bmp) => {
      if (!bmp) { this.tiles.delete(k); return; }
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" })!;
      ctx.drawImage(bmp, 0, 0);
      this.tiles.set(k, { d: ctx.getImageData(0, 0, bmp.width, bmp.height).data, w: bmp.width, h: bmp.height });
      this.loadedCount++;
      bmp.close();
    });
  }

  /**
   * Load the tiles overlapping a rectangle of mosaic pixels (e.g. the viewport), unless that is
   * more than `maxTiles` (zoomed far out over a big map: single pixels still load on demand).
   */
  prefetch(x0: number, y0: number, x1: number, y1: number, priority = 50, maxTiles = 24) {
    const { tile, factor, cols, rows } = this.info;
    const tx0 = Math.max(0, Math.floor((x0 * factor) / tile)), tx1 = Math.min(cols - 1, Math.floor((x1 * factor) / tile));
    const ty0 = Math.max(0, Math.floor((y0 * factor) / tile)), ty1 = Math.min(rows - 1, Math.floor((y1 * factor) / tile));
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > maxTiles) return;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) this.ensure(tx, ty, priority);
  }

  /** RGB of the layer pixel covering mosaic pixel (ix, iy), or null if outside / not loaded yet. */
  rgb(ix: number, iy: number): [number, number, number] | null {
    const { tile, factor, cols, rows } = this.info;
    const x = Math.floor(ix * factor), y = Math.floor(iy * factor);
    const tx = Math.floor(x / tile), ty = Math.floor(y / tile);
    if (x < 0 || y < 0 || tx >= cols || ty >= rows) return null;
    const t = this.tiles.get(this.key(tx, ty));
    if (t === undefined) { this.ensure(tx, ty, 10); return null; }
    if (t === null) return null;
    const lx = x - tx * tile, ly = y - ty * tile;
    if (lx >= t.w || ly >= t.h) return null;
    const k = (ly * t.w + lx) * 4;
    return [t.d[k], t.d[k + 1], t.d[k + 2]];
  }
}
