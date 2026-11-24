import type { TiledData } from "./tiles";

/**
 * Surface height per mosaic pixel, from the height data tiles (pipeline/build_roads.py, tiled by
 * export_web.py): half resolution, max-pooled, value = (h + 100) * 16 stored as R (high byte) +
 * G (low byte), 0 = unknown. B = 255 marks solid occluders (buildings, bridge / passage decks);
 * other tall pixels are trees.
 */
export class HeightField {
  constructor(readonly tiles: TiledData) {}

  /** Grows as height tiles arrive (cached drawings that depend on heights can refresh). */
  get loadedCount() {
    return this.tiles.loadedCount;
  }

  /** Surface height (m) at a mosaic pixel, or null if unknown / not loaded yet. */
  at(ix: number, iy: number): number | null {
    const p = this.tiles.rgb(ix, iy);
    if (!p) return null;
    const v = p[0] * 256 + p[1];
    return v === 0 ? null : v / 16 - 100;
  }

  /** Is the surface at this mosaic pixel solid (building / deck) rather than tree canopy? */
  solidAt(ix: number, iy: number): boolean {
    const p = this.tiles.rgb(ix, iy);
    return !!p && p[2] > 127;
  }
}
