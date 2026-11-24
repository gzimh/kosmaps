/**
 * world.json — everything the game places comes from data:
 * OpenStreetMap (buildings, roads, paths, pools, parks, places), a straight-down orthophoto
 * (ground and roof art, roof colours, trees) and a terrain height grid.
 *
 * Coordinates are metres in a local frame centred on `origin`: x = east, y = north.
 * (three.js scene: X = east, Y = up, Z = south, i.e. z = -y.)
 */
export type Pt = [number, number];

export interface WorldFile {
  name: string;
  origin: { lat: number; lon: number };
  /** Side of the square area in metres; the area spans [-sizeM/2, sizeM/2] on both axes. */
  sizeM: number;
  ground: {
    /** tiles x tiles full-resolution images `ground/<i>_<j>.jpg`, i = column from west, j = row from north. */
    tiles: number;
    tileM: number;
    tilePx: number;
    overviewPx: number;
  };
  terrain: {
    /** Grid spacing (m) and size; heights row 0 = north edge, relative to the area's ground level. */
    step: number;
    n: number;
    heights: number[];
  };
  roofAtlas: { px: number; h: number };
  /** The orthophoto's own sun (from its shadows) — used to light the scene like the photo by default. */
  photo: { shadowAzimuth: number; sunElevation: number };
  buildings: Building[];
  roads: Road[];
  paths: Path[];
  areas: Area[];
  trees: Tree[];
  places: Place[];
  credits: string;
}

export interface Building {
  id: string;
  name?: string;
  kind: string;
  /** Outer ring, counter-clockwise, metres. */
  poly: Pt[];
  /** Height of the walls (m) and how it was found. */
  h: number;
  hSource: "photo" | "known" | "typical" | "osm";
  roof: "flat" | "hip";
  /** Extra height of the hip roof's ridge above the walls (m). */
  roofH: number;
  /** Oriented box of the footprint (for hip roofs): centre, half sizes, angle (rad). */
  obb?: { c: Pt; hx: number; hy: number; a: number };
  roofColor: [number, number, number];
  wallColor: [number, number, number];
  /** Roof photo in the atlas: pixel rect of the building's bounding box [x, y, w, h] and the bbox in metres. */
  atlas: [number, number, number, number];
  bbox: [number, number, number, number];
  /** Where the roof is drawn in the photo relative to the footprint (the photo's lean), metres. */
  roofShift: Pt;
  levels: number;
}

export interface Road {
  id: string;
  kind: string;
  name?: string;
  width: number;
  oneway: boolean;
  pts: Pt[];
}

export interface Path {
  id: string;
  kind: string;
  pts: Pt[];
}

export interface Area {
  id: string;
  kind: "pool" | "park" | "pitch" | "playground" | "parking" | "grass";
  name?: string;
  poly: Pt[];
}

/** x, y, canopy radius (m), height (m), r, g, b (0-255, from the photo). */
export type Tree = [number, number, number, number, number, number, number];

export interface Place {
  name: string;
  kind: string;
  x: number;
  y: number;
}
