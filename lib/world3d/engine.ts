import * as THREE from "three";
import { smoothstep, sunPosition } from "@/lib/sun";
import { dateForMinutes, localMinutesNow } from "@/lib/time";
import { buildBuildings, type BuiltBuildings } from "./buildings";
import { Graph, type Edge, type SourceLine } from "./graph";
import { buildRoads, grainTexture } from "./roads";
import { buildLabels, buildLamps, buildPools, buildTrees } from "./scenery";
import { Ground, Terrain } from "./terrain";
import { Traffic, Walkers } from "./traffic";
import type { Building, WorldFile } from "./types";

/**
 * A live 3D miniature of an area built from data, seen through the same camera as the Dardania
 * map: orthographic, looking north-east (heading 45°), tilted 45° down. Pan and zoom only.
 */
export interface HudState {
  minutes: number;
  live: boolean;
  cars: number;
  walkers: number;
  fps: number;
  /** metres across the screen */
  viewWidth: number;
}

export interface Picked {
  building: Building;
  index: number;
}

const ROAD_SPEED: Record<string, number> = {
  motorway: 30, motorway_link: 15, trunk: 22, primary: 16, secondary: 14, tertiary: 12.5,
  unclassified: 11, residential: 8.5, living_street: 5, service: 6,
};
const WALK_KINDS = new Set(["footway", "pedestrian", "path", "steps", "living_street"]);
const SIM_DT = 1 / 60;
const S2 = Math.SQRT1_2;
/** Camera looks along heading 45° (north-east), pitch −45°: scene X = east, Z = south. */
const VIEW_DIR = new THREE.Vector3(0.5, -S2, -0.5).normalize();
const SCREEN_RIGHT = new THREE.Vector3(S2, 0, S2); // towards south-east
const SCREEN_UP_GROUND = new THREE.Vector3(S2, 0, -S2); // towards north-east
const MIN_VIEW = 40, MAX_VIEW = 2200;

export class World3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 6000);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  private readonly hemi = new THREE.HemisphereLight(0xbcd3ff, 0x6b5a45, 1);
  private readonly lampLights: THREE.PointLight[] = [];
  private readonly half: number;
  private readonly traffic: Traffic;
  private readonly walkers: Walkers;
  private readonly highlight = new THREE.Group();
  private readonly target = new THREE.Vector3();
  private viewWidth = 520;
  private raf = 0;
  private last = performance.now();
  private acc = 0;
  private simTime = 0;
  private fps = 60;
  private minutes = localMinutesNow();
  private live = true;
  private night = 0;
  private slowTimer = 0;
  private readonly keys = new Set<string>();
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private dragMoved = false;
  private pinchDist = 0;
  private readonly listeners: [EventTarget, string, EventListener][] = [];
  private readonly ro: ResizeObserver;

  private constructor(
    private readonly container: HTMLElement,
    readonly world: WorldFile,
    private readonly ground: Ground,
    private readonly built: BuiltBuildings,
    private readonly extras: {
      roads: THREE.Group;
      pools: ReturnType<typeof buildPools>;
      lamps: ReturnType<typeof buildLamps>;
      labels: ReturnType<typeof buildLabels>;
    },
    renderer: THREE.WebGLRenderer,
    private readonly terrain: Terrain,
    private readonly onPick: (p: Picked | null) => void,
  ) {
    this.renderer = renderer;
    this.half = world.sizeM / 2;
    this.scene.add(ground.group, extras.roads, built.walls, built.roofs, buildTrees(world, terrain), extras.pools.mesh,
      extras.lamps.group, extras.labels.group, this.highlight);

    // the fields around the mapped square: a big square with a hole for the map, below the terrain
    const h0 = this.half;
    const fields = new THREE.Shape([
      new THREE.Vector2(-9000, -9000), new THREE.Vector2(9000, -9000), new THREE.Vector2(9000, 9000), new THREE.Vector2(-9000, 9000),
    ]);
    fields.holes.push(new THREE.Path([
      new THREE.Vector2(-h0, -h0), new THREE.Vector2(-h0, h0), new THREE.Vector2(h0, h0), new THREE.Vector2(h0, -h0),
    ]));
    const outer = new THREE.Mesh(new THREE.ShapeGeometry(fields), new THREE.MeshStandardMaterial({ color: 0x9c8a62, roughness: 1 }));
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = Math.min(...world.terrain.heights) - 0.3;
    outer.receiveShadow = true;
    this.scene.add(outer);
    this.scene.background = new THREE.Color(0x9c8a62);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    this.scene.add(this.sun, this.sun.target, this.hemi);
    for (let i = 0; i < 12; i++) {
      const l = new THREE.PointLight(0xffd7a0, 0, 26, 1.5);
      this.lampLights.push(l);
      this.scene.add(l);
    }

    // traffic and people on the OSM networks
    const roadLines: SourceLine[] = world.roads.map((r) => ({
      pts: r.pts, width: r.width, kind: r.kind, name: r.name, oneway: r.oneway, speed: ROAD_SPEED[r.kind] ?? 8,
    }));
    const roadGraph = new Graph(roadLines, this.half, (e: Edge) => (e.oneway ? 0 : e.width / 4));
    const walkLines: SourceLine[] = [
      ...world.paths.filter((p) => WALK_KINDS.has(p.kind)).map((p) => ({ pts: p.pts, width: 2, kind: p.kind, oneway: false, speed: 1.3 })),
      ...world.roads.filter((r) => r.kind === "residential").map((r) => ({ pts: r.pts, width: r.width, kind: "pavement", oneway: false, speed: 1.3 })),
    ];
    const walkGraph = new Graph(walkLines, this.half, (e: Edge) => (e.kind === "pavement" ? e.width / 2 + 0.9 : 0.4));
    this.traffic = new Traffic(roadGraph, terrain, 70);
    this.walkers = new Walkers(walkGraph, terrain, 150);
    this.scene.add(this.traffic.group, this.walkers.group);

    // home view: centred on the estate's named places (the hotel and shops)
    const pl = world.places.filter((p) => Math.abs(p.x) < 400 && Math.abs(p.y) < 400);
    const cx = pl.length ? pl.reduce((s, p) => s + p.x, 0) / pl.length : 0;
    const cy = pl.length ? pl.reduce((s, p) => s + p.y, 0) / pl.length : 0;
    this.target.set(cx, 0, -cy);

    this.bindInput();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  static async create(container: HTMLElement, baseUrl: string, onPick: (p: Picked | null) => void): Promise<World3D> {
    const res = await fetch(`${baseUrl}/world.json`);
    if (!res.ok) throw new Error(`world.json: HTTP ${res.status}`);
    const world = (await res.json()) as WorldFile;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.style.display = "block";
    renderer.domElement.style.touchAction = "none";
    container.appendChild(renderer.domElement);
    const aniso = renderer.capabilities.getMaxAnisotropy();
    const loader = new THREE.TextureLoader();
    const [overview, roofs] = await Promise.all([
      loader.loadAsync(`${baseUrl}/ground/overview.jpg`),
      loader.loadAsync(`${baseUrl}/roofs.jpg`),
    ]);
    for (const t of [overview, roofs]) {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = aniso;
    }
    const terrain = new Terrain(world);
    const grain = grainTexture();
    const ground = new Ground(world, terrain, overview, baseUrl, aniso, grain);
    const built = buildBuildings(world, terrain, roofs);
    const streets = new Graph(
      world.roads.map((r) => ({ pts: r.pts, width: r.width, kind: r.kind, name: r.name, oneway: r.oneway, speed: 8 })),
      world.sizeM / 2,
      () => 0,
    );
    return new World3D(container, world, ground, built, {
      roads: buildRoads(streets, terrain, grain),
      pools: buildPools(world, terrain),
      lamps: buildLamps(streets, terrain),
      labels: buildLabels(world, terrain),
    }, renderer, terrain, onPick);
  }

  // ------------------------------------------------------------------ public API
  setTime(minutes: number | null) {
    if (minutes === null) {
      this.live = true;
      this.minutes = localMinutesNow();
    } else {
      this.live = false;
      this.minutes = minutes;
    }
  }

  hud(): HudState {
    return {
      minutes: this.minutes,
      live: this.live,
      cars: this.traffic.count,
      walkers: this.walkersActive(),
      fps: this.fps,
      viewWidth: this.viewWidth,
    };
  }

  /** Centre the view on a point (x east, y north, metres) at a given width (metres across). */
  lookAt(x: number, y: number, width?: number) {
    this.target.set(x, 0, -y);
    if (width) this.viewWidth = Math.min(MAX_VIEW, Math.max(MIN_VIEW, width));
    this.clampTarget();
  }

  zoomBy(f: number) {
    this.viewWidth = Math.min(MAX_VIEW, Math.max(MIN_VIEW, this.viewWidth * f));
  }

  clearSelection() {
    this.highlight.clear();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    for (const [t, ev, f] of this.listeners) t.removeEventListener(ev, f);
    this.ground.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ------------------------------------------------------------------ camera
  private resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.applyCamera();
  }

  private applyCamera() {
    const el = this.renderer.domElement;
    const aspect = el.clientWidth / Math.max(1, el.clientHeight);
    const hw = this.viewWidth / 2, hh = hw / aspect;
    const c = this.camera;
    c.left = -hw; c.right = hw; c.top = hh; c.bottom = -hh;
    c.position.copy(this.target).addScaledVector(VIEW_DIR, -2500);
    c.up.set(0, 1, 0);
    c.lookAt(this.target);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
  }

  /** Ground point (scene coords, y = 0) under a screen position. */
  private groundAt(cx: number, cy: number): THREE.Vector3 {
    const r = this.renderer.domElement.getBoundingClientRect();
    const mpp = this.viewWidth / r.width;
    const sx = (cx - r.left - r.width / 2) * mpp, sy = (r.height / 2 - (cy - r.top)) * mpp;
    return this.target.clone().addScaledVector(SCREEN_RIGHT, sx).addScaledVector(SCREEN_UP_GROUND, sy / S2);
  }

  private panPixels(dx: number, dy: number) {
    const mpp = this.viewWidth / this.renderer.domElement.clientWidth;
    this.target.addScaledVector(SCREEN_RIGHT, -dx * mpp).addScaledVector(SCREEN_UP_GROUND, (dy * mpp) / S2);
    this.clampTarget();
  }

  private zoomAt(f: number, cx: number, cy: number) {
    const before = this.groundAt(cx, cy);
    this.zoomBy(f);
    const after = this.groundAt(cx, cy);
    this.target.add(before.sub(after));
    this.clampTarget();
  }

  private clampTarget() {
    const m = this.half;
    this.target.x = Math.max(-m, Math.min(m, this.target.x));
    this.target.z = Math.max(-m, Math.min(m, this.target.z));
  }

  // ------------------------------------------------------------------ input
  private on(t: EventTarget, ev: string, f: EventListener, opts?: AddEventListenerOptions) {
    t.addEventListener(ev, f, opts);
    this.listeners.push([t, ev, f]);
  }

  private bindInput() {
    const el = this.renderer.domElement;
    this.on(window, "keydown", (e) => {
      const k = e as KeyboardEvent;
      const t = k.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (k.code === "Equal" || k.code === "NumpadAdd") this.zoomBy(1 / 1.25);
      else if (k.code === "Minus" || k.code === "NumpadSubtract") this.zoomBy(1.25);
      else this.keys.add(k.code);
    });
    this.on(window, "keyup", (e) => this.keys.delete((e as KeyboardEvent).code));
    this.on(window, "blur", () => this.keys.clear());
    this.on(el, "pointerdown", (e) => {
      const p = e as PointerEvent;
      el.setPointerCapture(p.pointerId);
      this.pointers.set(p.pointerId, { x: p.clientX, y: p.clientY });
      this.dragMoved = false;
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    this.on(el, "pointermove", (e) => {
      const p = e as PointerEvent;
      const prev = this.pointers.get(p.pointerId);
      if (!prev) return;
      const dx = p.clientX - prev.x, dy = p.clientY - prev.y;
      this.pointers.set(p.pointerId, { x: p.clientX, y: p.clientY });
      if (Math.abs(dx) + Math.abs(dy) > 0) this.dragMoved ||= Math.abs(dx) + Math.abs(dy) > 3;
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinchDist > 0) this.zoomAt(this.pinchDist / d, (a.x + b.x) / 2, (a.y + b.y) / 2);
        this.pinchDist = d;
        this.panPixels(dx / 2, dy / 2);
      } else {
        this.panPixels(dx, dy);
      }
    });
    const up = (e: Event) => {
      const p = e as PointerEvent;
      if (this.pointers.size === 1 && !this.dragMoved && e.type === "pointerup") this.pick(p.clientX, p.clientY);
      this.pointers.delete(p.pointerId);
      this.pinchDist = 0;
    };
    this.on(el, "pointerup", up);
    this.on(el, "pointercancel", up);
    this.on(el, "wheel", (e) => {
      const w = e as WheelEvent;
      w.preventDefault();
      this.zoomAt(Math.exp(w.deltaY * 0.0015), w.clientX, w.clientY);
    }, { passive: false });
  }

  private keyPan(dt: number) {
    const k = this.keys;
    const speed = 900 * dt; // px per second equivalent
    const x = (k.has("ArrowRight") || k.has("KeyD") ? 1 : 0) - (k.has("ArrowLeft") || k.has("KeyA") ? 1 : 0);
    const y = (k.has("ArrowDown") || k.has("KeyS") ? 1 : 0) - (k.has("ArrowUp") || k.has("KeyW") ? 1 : 0);
    if (x || y) this.panPixels(-x * speed, -y * speed);
  }

  private pick(cx: number, cy: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObjects([this.built.walls, this.built.roofs], false)[0];
    this.highlight.clear();
    if (!hit || hit.faceIndex == null) {
      this.onPick(null);
      return;
    }
    const idx = hit.object === this.built.walls ? this.built.wallTri[hit.faceIndex] : this.built.roofTri[hit.faceIndex];
    const b = this.world.buildings[idx];
    // outline the measured box: footprint at the base and at the wall top, plus the corners
    const base = this.built.base[idx];
    const pts: THREE.Vector3[] = [];
    const ring = b.poly;
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
      for (const z of [base + 0.05, base + b.h + 0.05]) pts.push(new THREE.Vector3(ax, z, -ay), new THREE.Vector3(bx, z, -by));
      pts.push(new THREE.Vector3(ax, base, -ay), new THREE.Vector3(ax, base + b.h, -ay));
    }
    const lines = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xffd23f, depthTest: false, transparent: true }),
    );
    lines.renderOrder = 5;
    this.highlight.add(lines);
    this.onPick({ building: b, index: idx });
  }

  // ------------------------------------------------------------------ world
  private walkersActive() {
    const t = this.minutes / 60;
    const day = t < 6 ? 0.08 : t < 8 ? 0.4 : t < 21 ? 1 : t < 23 ? 0.45 : 0.12;
    return Math.round(this.walkers.total * day);
  }

  private updateLighting() {
    const date = dateForMinutes(this.minutes);
    const { elevation, azimuth } = sunPosition(date, this.world.origin.lat, this.world.origin.lon);
    const el = (elevation * Math.PI) / 180, az = (azimuth * Math.PI) / 180;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    const night = smoothstep(4, -7, elevation);
    const day = smoothstep(-3, 14, elevation);
    this.night = night;

    const low = 1 - smoothstep(4, 28, elevation);
    let lightDir = dir;
    if (elevation > -2) {
      this.sun.color.setRGB(1, 0.96 - 0.3 * low, 0.9 - 0.48 * low);
      this.sun.intensity = 3.4 * smoothstep(-2, 10, elevation);
    } else {
      // moonlight: soft, bluish, from high up
      lightDir = new THREE.Vector3(-dir.x, Math.abs(dir.y) + 0.6, -dir.z).normalize();
      this.sun.color.setRGB(0.55, 0.65, 1);
      this.sun.intensity = 0.35 * night;
    }
    // shadow map covers what's on screen (the view's ground footprint is ~1.4× taller than wide)
    const r = Math.min(1300, Math.max(90, this.viewWidth * 0.8));
    const sc = this.sun.shadow.camera;
    sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.near = 10; sc.far = 3000;
    sc.updateProjectionMatrix();
    this.sun.target.position.copy(this.target);
    this.sun.position.copy(this.target).addScaledVector(lightDir, 1200);
    this.sun.target.updateMatrixWorld();

    this.hemi.intensity = 0.25 + 1.05 * day;
    this.hemi.color.setRGB(0.55 + 0.2 * day, 0.62 + 0.22 * day, 0.85 + 0.15 * day);
    this.hemi.groundColor.setRGB(0.25 + 0.17 * day, 0.22 + 0.13 * day, 0.2 + 0.07 * day);
    const sky = new THREE.Color(0.05 + 0.65 * day, 0.07 + 0.7 * day, 0.12 + 0.74 * day);
    (this.scene.background as THREE.Color).setRGB(0.61 * (0.15 + 0.85 * day), 0.54 * (0.15 + 0.85 * day), 0.38 * (0.18 + 0.82 * day));
    this.renderer.toneMappingExposure = 0.85 + 0.15 * night;

    this.built.setNight(night);
    this.built.setSky(sky);
    this.traffic.setNight(night);
    this.extras.lamps.setNight(night);
  }

  private updateLampLights() {
    const f = this.target;
    const lit = this.night > 0.05 && this.viewWidth < 700;
    const bulbs = this.extras.lamps.bulbs
      .map((b) => ({ b, d: (b.x - f.x) ** 2 + (b.z - f.z) ** 2 }))
      .sort((a, c) => a.d - c.d);
    this.lampLights.forEach((l, i) => {
      const b = bulbs[i];
      l.visible = lit && !!b;
      if (b) l.position.copy(b.b);
      l.intensity = 30 * this.night;
    });
  }

  private loop(now: number) {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;
    if (this.live) this.minutes = localMinutesNow() + new Date().getSeconds() / 60;

    this.acc += dt;
    let steps = 0;
    while (this.acc >= SIM_DT && steps < 6) {
      this.traffic.update(SIM_DT, null);
      this.acc -= SIM_DT;
      this.simTime += SIM_DT;
      steps++;
    }
    if (steps === 6) this.acc = 0;
    this.walkers.update(dt, this.walkersActive(), null);
    this.traffic.render();
    this.extras.pools.tick(this.simTime);

    this.keyPan(dt);
    this.applyCamera();

    this.slowTimer -= dt;
    if (this.slowTimer <= 0) {
      this.slowTimer = 0.25;
      const f = this.target;
      // full-resolution ground photo only when zoomed in enough to see it
      const near = this.viewWidth < 900 ? this.viewWidth * 0.9 + 150 : 0;
      this.ground.update(f.x, -f.z, near, near + 250);
      this.extras.labels.update(f.x, -f.z, this.viewWidth < 1000 ? this.viewWidth * 0.75 : 0, this.camera);
      this.updateLampLights();
    }
    this.updateLighting();
    this.renderer.render(this.scene, this.camera);
  }
}
