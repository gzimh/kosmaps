import { FRAGMENT_SHADER, VERTEX_SHADER } from "./shaders";
import type { TileLoader } from "./tiles";

/** One layer's pyramid: level z has finest * 2^(maxZ - z) mosaic px per tile px. */
export interface LayerPyramid {
  maxZ: number;
  /** Mosaic px per tile px at the finest level (0.5 = upscaled 2x, 2 = half resolution). */
  finest: number;
}

/** meta.json "pyramid": imagery tiles written by pipeline/export_web.py. */
export interface PyramidInfo {
  tileSize: number;
  gutter: number;
  /** Image formats available, best first (e.g. avif, webp). */
  formats: string[];
  layers: { day: LayerPyramid; night: LayerPyramid; up: LayerPyramid };
  /** Sparse maps: per layer, per level, the [x, y] of every tile that exists (absent = all exist). */
  index?: Record<string, Record<string, [number, number][]>>;
}

/** Best tile format this browser decodes (AVIF if it can). */
export async function pickTileFormat(formats: string[]): Promise<string> {
  if (formats.includes("avif")) {
    // 1x1 AVIF (made with Pillow); createImageBitmap rejects it where AVIF isn't supported
    const avif = "AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADrbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAETAAAAJQAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAABqaXBycAAAAEtpcGNvAAAAFGlzcGUAAAAAAAAAAQAAAAEAAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAALW1kYXQSAAoIGAAGiAhoNCAyFxlHh4Yhh5555oAAAJBAyRxgk6YoGhCA";
    try {
      const blob = await (await fetch(`data:image/avif;base64,${avif}`)).blob();
      (await createImageBitmap(blob)).close();
      return "avif";
    } catch {
      /* fall through */
    }
  }
  return formats.find((f) => f !== "avif") ?? formats[0];
}

type Layer = "day" | "night" | "up";
interface TileTex { tex: WebGLTexture; w: number; h: number; last: number }

/** GPU memory budget, in tiles (each ~1 MB with mipmaps). */
const MAX_TEXTURES = 160;

export interface FrameUniforms {
  nightK: number;
  rain: number;
  snow: number;
  smog: number;
  time: number;
}

const MAX_SCALE = 4;

/**
 * WebGL2 renderer for the illustrated mosaic plus the pan/zoom view.
 * View state is in device pixels: `off` is the image pixel at the canvas origin,
 * `scale` is device px per image px.
 */
export class MapRenderer {
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  private buffer: WebGLBuffer;
  private tex = new Map<string, TileTex>();
  private pending = new Set<string>();
  private dummy!: WebGLTexture;
  private frameNo = 0;
  private pyr: PyramidInfo | null = null;
  private format = "webp";
  private baseUrl = "";
  private loader: TileLoader | null = null;
  private readyResolve: (() => void) | null = null;
  /** Resolves once the coarsest level is on screen. */
  readonly ready: Promise<void>;

  /** World size in image px (the map may be sparse inside it). */
  imageW = 3072;
  imageH = 3072;
  private minScale = 0.08;
  private homeRect: [number, number, number, number] | null = null;
  private exists: Map<string, Set<string>> | null = null;
  scale = 0.3;
  off: [number, number] = [0, 0];
  dpr = 1;

  constructor(private canvas: HTMLCanvasElement) {
    this.ready = new Promise((r) => { this.readyResolve = r; });
    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error("WebGL2 is not available in this browser.");
    this.gl = gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link error");
    gl.useProgram(prog);
    this.prog = prog;

    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  private u(name: string) {
    if (!this.uniforms.has(name)) this.uniforms.set(name, this.gl.getUniformLocation(this.prog, name));
    return this.uniforms.get(name)!;
  }

  /** Use a tile pyramid; tiles are fetched on demand through `loader`. */
  setPyramid(size: number | [number, number], info: PyramidInfo, baseUrl: string, loader: TileLoader, format: string,
    homeRect?: [number, number, number, number]) {
    [this.imageW, this.imageH] = typeof size === "number" ? [size, size] : size;
    this.homeRect = homeRect ?? null;
    if (info.index) {
      this.exists = new Map();
      for (const [layer, levels] of Object.entries(info.index))
        for (const [z, keys] of Object.entries(levels)) this.exists.set(`${layer}/${z}`, new Set(keys.map(([x, y]) => `${x}_${y}`)));
    }
    this.pyr = info;
    this.format = format;
    this.baseUrl = baseUrl;
    this.loader = loader;
    const gl = this.gl;
    this.dummy = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.dummy);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(this.u("uDay"), 0);
    gl.uniform1i(this.u("uNight"), 1);
    gl.uniform1i(this.u("uUp"), 2);
    gl.uniform1f(this.u("uGutter"), info.gutter);
  }

  private upload(bmp: ImageBitmap): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Texture for a tile layer if loaded; otherwise ask for it (lower priority = sooner). */
  private tile(layer: Layer, z: number, x: number, y: number, priority: number | null): TileTex | null {
    const key = `${layer}/${z}/${x}_${y}`;
    const t = this.tex.get(key);
    if (t) { t.last = this.frameNo; return t; }
    if (this.exists && !this.exists.get(`${layer}/${z}`)?.has(`${x}_${y}`)) return null;   // blank: no tile
    if (priority === null || !this.loader || !this.pyr) return null;
    if (this.pending.has(key)) { this.loader.request(key, "", priority); return null; }   // just renew it
    const p = this.loader.request(key, `${this.baseUrl}/${layer}/${z}/${x}_${y}.${this.format}`, priority);
    if (p) {
      this.pending.add(key);
      p.then((bmp) => {
        this.pending.delete(key);
        if (!bmp) return;
        this.tex.set(key, { tex: this.upload(bmp), w: bmp.width, h: bmp.height, last: this.frameNo });
        bmp.close();
      });
    }
    return null;
  }

  /** Free the least recently used tiles over the budget (never ones drawn this frame). */
  private evict() {
    if (this.tex.size <= MAX_TEXTURES) return;
    const old = [...this.tex.entries()].filter(([, t]) => t.last < this.frameNo).sort((a, b) => a[1].last - b[1].last);
    for (const [key, t] of old.slice(0, this.tex.size - MAX_TEXTURES)) {
      this.gl.deleteTexture(t.tex);
      this.tex.delete(key);
    }
  }

  /** Diagnostics: tiles on the GPU / loading. */
  get tileStats() {
    return { textures: this.tex.size, pending: this.pending.size };
  }

  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number) {
    // phones: a 1.5x canvas looks nearly as sharp as 3x and draws 4x fewer pixels
    const small = Math.min(cssWidth, cssHeight) < 700;
    this.dpr = Math.min(devicePixelRatio || 1, small ? 1.5 : 2);
    this.canvas.width = Math.round(cssWidth * this.dpr);
    this.canvas.height = Math.round(cssHeight * this.dpr);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  get width() { return this.canvas.width; }
  get height() { return this.canvas.height; }

  /** Fit the home rectangle (or the whole map) in view. */
  home() {
    const { width, height } = this;
    const [x0, y0, x1, y1] = this.homeRect ?? [0, 0, this.imageW, this.imageH];
    this.scale = Math.min(width / (x1 - x0), height / (y1 - y0)) * 0.96;
    this.minScale = Math.min(0.08, Math.min(width / this.imageW, height / this.imageH) * 0.8);
    this.off = [(x0 + x1) / 2 - width / this.scale / 2, (y0 + y1) / 2 - height / this.scale / 2];
  }

  /** Centre the view on an image point at a given scale (device px per image px). */
  lookAt(ix: number, iy: number, scale = this.scale) {
    this.scale = Math.min(MAX_SCALE, Math.max(this.minScale, scale));
    this.off = [ix - this.width / this.scale / 2, iy - this.height / this.scale / 2];
  }

  /** Zoom by factor k around a point given in CSS px. */
  zoomAt(cssX: number, cssY: number, k: number) {
    const cx = cssX * this.dpr, cy = cssY * this.dpr;
    const ns = Math.min(MAX_SCALE, Math.max(this.minScale, this.scale * k));
    this.off = [this.off[0] + cx / this.scale - cx / ns, this.off[1] + cy / this.scale - cy / ns];
    this.scale = ns;
  }

  panBy(cssDx: number, cssDy: number) {
    this.off = [this.off[0] - (cssDx * this.dpr) / this.scale, this.off[1] - (cssDy * this.dpr) / this.scale];
  }

  /** Image pixel under a CSS-px point, or null if outside the mosaic. */
  imagePixelAt(cssX: number, cssY: number): [number, number] | null {
    const ix = Math.floor(this.off[0] + (cssX * this.dpr) / this.scale);
    const iy = Math.floor(this.off[1] + (cssY * this.dpr) / this.scale);
    if (ix < 0 || iy < 0 || ix >= this.imageW || iy >= this.imageH) return null;
    return [ix, iy];
  }

  /** Image pixel -> canvas device px. */
  toCanvas(ix: number, iy: number): [number, number] {
    return [(ix - this.off[0]) * this.scale, (iy - this.off[1]) * this.scale];
  }

  draw(f: FrameUniforms) {
    const gl = this.gl, pyr = this.pyr;
    this.frameNo++;
    const bg = [0.94 + (0.10 - 0.94) * f.nightK, 0.91 + (0.10 - 0.91) * f.nightK, 0.85 + (0.14 - 0.85) * f.nightK];
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!pyr) return;
    this.loader?.tick();

    gl.uniform2f(this.u("uRes"), this.width, this.height);
    gl.uniform2f(this.u("uOff"), this.off[0], this.off[1]);
    gl.uniform1f(this.u("uScale"), this.scale);

    gl.uniform1f(this.u("uNightK"), f.nightK);
    gl.uniform1f(this.u("uRain"), f.rain);
    gl.uniform1f(this.u("uSnow"), f.snow);
    gl.uniform1f(this.u("uSmog"), f.smog);
    gl.uniform1f(this.u("uTime"), f.time);

    // only fetch what the current conditions show
    const need = { day: f.nightK < 0.999, night: f.nightK > 0.001, up: f.rain > 0.001 || f.snow > 0.001 };
    // finest level whose pixels are no smaller than a screen pixel (day and night share a pyramid)
    const L = pyr.layers.day, U = pyr.layers.up;
    const levelF = (lp: LayerPyramid, z: number) => lp.finest * 2 ** (lp.maxZ - z);
    const fWanted = Math.min(levelF(L, 0), Math.max(L.finest, 2 ** Math.floor(Math.log2(1 / this.scale))));
    const zTarget = L.maxZ - Math.round(Math.log2(fWanted / L.finest));
    const vx0 = this.off[0], vy0 = this.off[1];
    const vx1 = vx0 + this.width / this.scale, vy1 = vy0 + this.height / this.scale;
    const cx = (vx0 + vx1) / 2, cy = (vy0 + vy1) / 2;
    const T = pyr.tileSize;

    let drewCoarsest = false;
    // coarse to fine: finer tiles paint over coarser ones as they arrive, so there are never holes
    for (let z = 0; z <= zTarget; z++) {
      const f = levelF(L, z);
      const span = T * f;                            // mosaic px per tile
      // the mask tile covering this level's tiles: same resolution or its own coarsest
      const zu = Math.max(0, Math.min(U.maxZ, U.maxZ - Math.round(Math.log2(Math.max(f, U.finest) / U.finest))));
      const fu = levelF(U, zu), spanU = T * fu;
      const nx = Math.ceil(this.imageW / span), ny = Math.ceil(this.imageH / span);
      const tx0 = Math.max(0, Math.floor(vx0 / span)), tx1 = Math.min(nx - 1, Math.floor(vx1 / span));
      const ty0 = Math.max(0, Math.floor(vy0 / span)), ty1 = Math.min(ny - 1, Math.floor(vy1 / span));
      const fetchHere = z === 0 || z === zTarget;
      // sparse maps: sources stop at different detail (the illustrated areas go to 2x, the road to
      // 1x, the city background to 4x coarser). Where the next finer level is missing any of a tile's
      // four children, this level is the finest there is for part of it, so fetch it too.
      const has = (layer: string, zz: number, x: number, y: number) => !!this.exists?.get(`${layer}/${zz}`)?.has(`${x}_${y}`);
      const gapBelow = z < zTarget && !!this.exists;
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const dist = Math.hypot((tx + 0.5) * span - cx, (ty + 0.5) * span - cy) / span;
          const gap = gapBelow && has("day", z, tx, ty) && !(has("day", z + 1, 2 * tx, 2 * ty) && has("day", z + 1, 2 * tx + 1, 2 * ty)
            && has("day", z + 1, 2 * tx, 2 * ty + 1) && has("day", z + 1, 2 * tx + 1, 2 * ty + 1));
          const prio = fetchHere || gap ? (z === 0 ? 0 : 10 + dist) : null;
          const day = this.tile("day", z, tx, ty, need.day || z === 0 ? prio : null);
          const night = this.tile("night", z, tx, ty, need.night || z === 0 ? prio : null);
          const ox = tx * span, oy = ty * span;
          const ux = Math.floor(ox / spanU), uy = Math.floor(oy / spanU);
          const up = this.tile("up", zu, ux, uy, need.up || z === 0 ? (prio === null ? null : prio + 5) : null);
          const base = day ?? night;
          if (!base) continue;
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, (day ?? night)!.tex);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, (night ?? day)!.tex);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, up ? up.tex : this.dummy);
          const ex = Math.min(this.imageW, ox + span), ey = Math.min(this.imageH, oy + span);
          const [rx0, ry0] = this.toCanvas(ox, oy), [rx1, ry1] = this.toCanvas(ex, ey);
          gl.uniform4f(this.u("uRect"), rx0, ry0, rx1, ry1);
          gl.uniform2f(this.u("uTileOrigin"), ox, oy);
          gl.uniform1f(this.u("uTileF"), f);
          gl.uniform2f(this.u("uTexSize"), base.w, base.h);
          gl.uniform2f(this.u("uUpOrigin"), ux * spanU, uy * spanU);
          gl.uniform1f(this.u("uUpF"), fu);
          gl.uniform2f(this.u("uUpTexSize"), up ? up.w : 1, up ? up.h : 1);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          if (z === 0) drewCoarsest = true;
        }
      }
    }
    if (drewCoarsest && this.readyResolve) { this.readyResolve(); this.readyResolve = null; }
    this.evict();
  }

  dispose() {
    const gl = this.gl;
    this.tex.forEach((t) => gl.deleteTexture(t.tex));
    this.tex.clear();
    gl.deleteBuffer(this.buffer);
    gl.deleteProgram(this.prog);
  }
}
