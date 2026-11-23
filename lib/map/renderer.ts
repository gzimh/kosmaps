import { FRAGMENT_SHADER, VERTEX_SHADER } from "./shaders";
import type { TileLoader } from "./tiles";

/** meta.json "pyramid": imagery tiles written by pipeline/export_web.py. */
export interface PyramidInfo {
  tileSize: number;
  gutter: number;
  /** Finest level; level z has 2^(maxZ - z) mosaic px per tile px. */
  maxZ: number;
  format: string;
  layers: string[];
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

const MIN_SCALE = 0.08;
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
  private baseUrl = "";
  private loader: TileLoader | null = null;
  private readyResolve: (() => void) | null = null;
  /** Resolves once the coarsest level is on screen. */
  readonly ready: Promise<void>;

  imageSize = 3072;
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
  setPyramid(size: number, info: PyramidInfo, baseUrl: string, loader: TileLoader) {
    this.imageSize = size;
    this.pyr = info;
    this.baseUrl = baseUrl;
    this.loader = loader;
    const gl = this.gl;
    this.dummy = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.dummy);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0]));
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
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, bmp);
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
    if (priority === null || !this.loader || !this.pyr) return null;
    if (this.pending.has(key)) { this.loader.request(key, "", priority); return null; }   // just renew it
    const p = this.loader.request(key, `${this.baseUrl}/${layer}/${z}/${x}_${y}.${this.pyr.format}`, priority);
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
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(cssWidth * this.dpr);
    this.canvas.height = Math.round(cssHeight * this.dpr);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  get width() { return this.canvas.width; }
  get height() { return this.canvas.height; }

  /** Fit the whole map in view. */
  home() {
    const { width, height, imageSize } = this;
    this.scale = (Math.min(width, height) / imageSize) * 0.98;
    this.off = [(imageSize - width / this.scale) / 2, (imageSize - height / this.scale) / 2];
  }

  /** Zoom by factor k around a point given in CSS px. */
  zoomAt(cssX: number, cssY: number, k: number) {
    const cx = cssX * this.dpr, cy = cssY * this.dpr;
    const ns = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * k));
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
    if (ix < 0 || iy < 0 || ix >= this.imageSize || iy >= this.imageSize) return null;
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
    gl.uniform1f(this.u("uImg"), this.imageSize);
    gl.uniform1f(this.u("uNightK"), f.nightK);
    gl.uniform1f(this.u("uRain"), f.rain);
    gl.uniform1f(this.u("uSnow"), f.snow);
    gl.uniform1f(this.u("uSmog"), f.smog);
    gl.uniform1f(this.u("uTime"), f.time);

    // only fetch what the current conditions show
    const need = { day: f.nightK < 0.999, night: f.nightK > 0.001, up: f.rain > 0.001 || f.snow > 0.001 };
    // finest level whose pixels are no smaller than a screen pixel
    const fWanted = Math.min(2 ** pyr.maxZ, Math.max(1, 2 ** Math.floor(Math.log2(1 / this.scale))));
    const zTarget = pyr.maxZ - Math.round(Math.log2(fWanted));
    const vx0 = this.off[0], vy0 = this.off[1];
    const vx1 = vx0 + this.width / this.scale, vy1 = vy0 + this.height / this.scale;
    const cx = (vx0 + vx1) / 2, cy = (vy0 + vy1) / 2;
    const T = pyr.tileSize;

    let drewCoarsest = false;
    // coarse to fine: finer tiles paint over coarser ones as they arrive, so there are never holes
    for (let z = 0; z <= zTarget; z++) {
      const span = T * 2 ** (pyr.maxZ - z);          // mosaic px per tile
      const n = Math.ceil(this.imageSize / span);
      const tx0 = Math.max(0, Math.floor(vx0 / span)), tx1 = Math.min(n - 1, Math.floor(vx1 / span));
      const ty0 = Math.max(0, Math.floor(vy0 / span)), ty1 = Math.min(n - 1, Math.floor(vy1 / span));
      const fetchHere = z === 0 || z === zTarget;
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const dist = Math.hypot((tx + 0.5) * span - cx, (ty + 0.5) * span - cy) / span;
          const prio = fetchHere ? (z === 0 ? 0 : 10 + dist) : null;
          const day = this.tile("day", z, tx, ty, need.day || z === 0 ? prio : null);
          const night = this.tile("night", z, tx, ty, need.night || z === 0 ? prio : null);
          const up = this.tile("up", z, tx, ty, need.up || z === 0 ? (prio === null ? null : prio + 5) : null);
          const base = day ?? night;
          if (!base) continue;
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, (day ?? night)!.tex);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, (night ?? day)!.tex);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, up ? up.tex : this.dummy);
          const ox = tx * span, oy = ty * span;
          const ex = Math.min(this.imageSize, ox + span), ey = Math.min(this.imageSize, oy + span);
          const [rx0, ry0] = this.toCanvas(ox, oy), [rx1, ry1] = this.toCanvas(ex, ey);
          gl.uniform4f(this.u("uRect"), rx0, ry0, rx1, ry1);
          gl.uniform2f(this.u("uTileOrigin"), ox, oy);
          gl.uniform1f(this.u("uTileF"), 2 ** (pyr.maxZ - z));
          gl.uniform2f(this.u("uTexSize"), base.w, base.h);
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
