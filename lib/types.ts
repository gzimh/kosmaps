import type { PerimeterInfo } from "./map/perimeterBlur";
import type { PyramidInfo } from "./map/renderer";
import type { DataTileInfo } from "./map/tiles";

/** One clickable building, as written by pipeline/build_buildings.py. */
export interface Building {
  id: number;
  osm: string;
  name: string | null;
  addr: string | null;
  use: string;
  levels: string | null;
  levels_est: number;
  start: string | null;
  height: number;
  ground: number;
  roof: number;
  roof_main?: number;
  inside: string[];
  /** Footprint ring in local metres east/north of the map centre (closed: first === last). */
  fp: [number, number][];
  fixed?: boolean;
}

export interface BuildingsFile {
  lat0: number;
  lon0: number;
  /** Metres per mosaic pixel. */
  mpp: number;
  /** Mosaic size in pixels (square). */
  npx: number;
  buildings: Building[];
}

/** public/data/meta.json, written by pipeline/export_web.py. */
export interface MapMeta {
  lat: number;
  lon: number;
  size: number;
  mpp: number;
  credits: string;
  /** Imagery tile pyramid (day, night, sky-facing mask) under data/tiles/<layer>/<z>/<x>_<y>. */
  /** Tile set version: tiles live under data/tiles/<version>/ and can be cached forever. */
  tiles: string;
  pyramid: PyramidInfo;
  /** CPU data tiles under data/tiles/<name>/<x>_<y>.png. */
  data: { idmap: DataTileInfo; height?: DataTileInfo };
  /** Optional: surroundings under the map (pipeline/backdrop.py), covering rect (image px). */
  backdrop?: { file: string; rect: [number, number, number, number] };
  /** Optional: the neighbourhood's perimeter (pipeline/perimeter.py), for the blur layer. */
  perimeter?: PerimeterInfo;
  layers: {
    buildings: string;
    /** Optional: road graph for simulated traffic (pipeline/build_roads.py). */
    roads?: string;
    /** Optional: weekly traffic pattern baked from a one-time Google harvest. */
    trafficProfile?: string;
    /** Optional: researched landmarks with map positions (pipeline/landmarks.json). */
    landmarks?: string;
    /** Optional: parked cars as 3D objects (pipeline/build_parking.py). */
    parkedCars?: string;
  };
}

export interface Weather {
  temp: number;
  desc: string;
  rain: number;
  snow: number;
  pm: number;
}

/** Everything the shader needs that the user (or live data) controls. */
export interface Conditions {
  minutes: number;
  rain: number;
  snow: number;
  pm: number;
}
