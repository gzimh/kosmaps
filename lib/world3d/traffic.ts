import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Graph, Lane } from "./graph";
import type { Terrain } from "./terrain";

/** A moving obstacle the simulation must respect (the player's car). */
export interface Mover {
  x: number;
  y: number;
  h: number;
  r: number;
}

interface Car {
  lane: number;
  s: number;
  v: number;
  len: number;
  next: number;
  reserved: number;
  wait: number;
  x: number;
  y: number;
  h: number;
  vh: number;
  color: THREE.Color;
  braking: boolean;
}

const CAR_COLORS = ["#f4f4f2", "#1d1f22", "#8d9298", "#c2c6ca", "#22324f", "#7a1d1d", "#3b4a3a", "#ece6da", "#2c2c2c", "#b9babd"];
const tmp = { x: 0, y: 0, h: 0 };

/** Extrude a side profile (x = length, front +X; y = up) across the car's width, centred. */
function profile(pts: [number, number][], width: number, bevel = 0.04) {
  const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: width - 2 * bevel, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 4,
  });
  g.translate(0, 0, -(width - 2 * bevel) / 2);
  return g;
}

/** A small hatchback at real size (4.3 m), front = +X: body, glass cabin, roof, wheels, lights. */
export function carGeometries() {
  const body = profile([
    [-2.12, 0.3], [2.08, 0.3], [2.17, 0.42], [2.17, 0.66], [2.06, 0.82], [1.05, 0.95],
    [-1.75, 0.99], [-2.1, 0.94], [-2.17, 0.7], [-2.17, 0.42],
  ], 1.78);
  const glass = profile([[1.02, 0.93], [0.3, 1.38], [-1.18, 1.42], [-1.86, 0.98]], 1.6, 0.02);
  const roof = profile([[0.36, 1.36], [0.24, 1.45], [-1.15, 1.48], [-1.26, 1.4]], 1.5, 0.02);
  const wheels: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[1.33, 0.8], [1.33, -0.8], [-1.33, 0.8], [-1.33, -0.8]]) {
    const w = new THREE.CylinderGeometry(0.33, 0.33, 0.22, 16);
    w.rotateX(Math.PI / 2);
    w.translate(x, 0.33, z);
    wheels.push(w);
  }
  const head: THREE.BufferGeometry[] = [];
  for (const z of [0.6, -0.6]) {
    const l = new THREE.BoxGeometry(0.08, 0.13, 0.36);
    l.translate(2.15, 0.72, z);
    head.push(l);
  }
  const tail: THREE.BufferGeometry[] = [];
  for (const z of [0.66, -0.66]) {
    const l = new THREE.BoxGeometry(0.08, 0.16, 0.28);
    l.translate(-2.17, 0.8, z);
    tail.push(l);
  }
  return {
    body: mergeGeometries([body, roof])!,
    glass,
    wheels: mergeGeometries(wheels)!,
    head: mergeGeometries(head)!,
    tail: mergeGeometries(tail)!,
  };
}

export class Traffic {
  readonly group = new THREE.Group();
  private readonly cars: Car[] = [];
  private readonly reservations = new Map<number, number>(); // node -> car index
  private readonly meshes: Record<"body" | "glass" | "wheels" | "head" | "tail", THREE.InstancedMesh>;
  private readonly headMat: THREE.MeshBasicMaterial;
  private readonly entries: number[];
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private night = 0;

  constructor(private readonly g: Graph, private readonly terrain: Terrain, count: number) {
    const geos = carGeometries();
    const max = count + 8;
    // lights are unlit; colours above 1 read as glowing after tone mapping
    this.headMat = new THREE.MeshBasicMaterial({ color: 0xcfcfcf });
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, shadow: boolean) => {
      const m = new THREE.InstancedMesh(geo, mat, max);
      m.castShadow = shadow;
      m.receiveShadow = false;
      m.count = 0;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    };
    this.meshes = {
      body: mk(geos.body, new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.35 }), true),
      glass: mk(geos.glass, new THREE.MeshStandardMaterial({ color: 0x24303c, roughness: 0.12, metalness: 0.55 }), true),
      wheels: mk(geos.wheels, new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }), false),
      head: mk(geos.head, this.headMat, false),
      tail: mk(geos.tail, new THREE.MeshBasicMaterial(), false),
    };
    // where cars come in from beyond the map: lanes starting at a boundary dead end
    this.entries = g.lanes.filter((l) => g.nodes[l.from].boundary && g.nodes[l.from].degree === 1).map((l) => l.id);
    const drivable = g.lanes.filter((l) => l.length > 12);
    for (let i = 0; i < count && drivable.length; i++) {
      const lane = drivable[Math.floor(Math.random() * drivable.length)];
      this.spawn(lane, Math.random() * lane.length);
    }
  }

  get count() {
    return this.cars.length;
  }

  private spawn(lane: Lane, s: number) {
    for (const c of this.cars) if (c.lane === lane.id && Math.abs(c.s - s) < 9) return;
    const len = 4.3;
    this.g.at(lane, s, tmp);
    const c: Car = {
      lane: lane.id, s, v: lane.speed * 0.6, len, next: -1, reserved: -1, wait: 0,
      x: tmp.x, y: tmp.y, h: tmp.h, vh: tmp.h,
      color: new THREE.Color(CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)]),
      braking: false,
    };
    c.next = this.pickNext(c);
    this.cars.push(c);
  }

  private pickNext(c: Car): number {
    const lane = this.g.lanes[c.lane];
    const node = this.g.nodes[lane.to];
    const opts = node.out.filter((id) => this.g.lanes[id].edge !== lane.edge);
    if (opts.length) {
      // mild preference for staying on bigger roads
      const w = opts.map((id) => (this.g.lanes[id].speed > 10 ? 2.5 : 1));
      let r = Math.random() * w.reduce((a, b) => a + b, 0);
      for (let i = 0; i < opts.length; i++) if ((r -= w[i]) <= 0) return opts[i];
      return opts[0];
    }
    if (node.boundary) return -1; // leaves the map
    const back = this.g.reverse(lane); // dead end inside the map: turn round
    return back ? back.id : -1;
  }

  setNight(k: number) {
    this.night = k;
    this.headMat.color.setRGB(0.8 + 3.2 * k, 0.8 + 3.0 * k, 0.75 + 2.4 * k);
  }

  update(dt: number, player: Mover | null) {
    const g = this.g;
    const byLane = new Map<number, number[]>();
    this.cars.forEach((c, i) => {
      const a = byLane.get(c.lane);
      if (a) a.push(i); else byLane.set(c.lane, [i]);
    });
    for (const a of byLane.values()) a.sort((i, j) => this.cars[i].s - this.cars[j].s);

    for (let ci = 0; ci < this.cars.length; ci++) {
      const c = this.cars[ci];
      const lane = g.lanes[c.lane];
      const L = lane.length;
      let gap = 1e9, lv = 0;
      // leader on the same lane
      const same = byLane.get(c.lane)!;
      const k = same.indexOf(ci);
      if (k < same.length - 1) {
        const o = this.cars[same[k + 1]];
        gap = o.s - c.s - (o.len + c.len) / 2;
        lv = o.v;
      } else if (c.next >= 0) {
        const nx = byLane.get(c.next);
        if (nx && nx.length) {
          const o = this.cars[nx[0]];
          gap = L - c.s + o.s - (o.len + c.len) / 2;
          lv = o.v;
        }
      }
      // junction: one car at a time through a node where 3+ roads meet
      const endNode = lane.to;
      const distEnd = L - c.s;
      if (g.nodes[endNode].degree >= 3 && distEnd < 14) {
        const holder = this.reservations.get(endNode);
        if (holder === undefined || holder === ci || !this.cars[holder]) {
          this.reservations.set(endNode, ci);
          c.reserved = endNode;
        } else if (c.wait < 7) {
          const stop = distEnd - 2.5 - c.len / 2;
          if (stop < gap) { gap = Math.max(0, stop); lv = 0; }
        }
      }
      // the player's car
      if (player) {
        const dx = player.x - c.x, dy = player.y - c.y;
        const fwd = dx * Math.cos(c.h) + dy * Math.sin(c.h);
        const lat = Math.abs(-dx * Math.sin(c.h) + dy * Math.cos(c.h));
        if (fwd > 0 && fwd < 30 && lat < 2.4) {
          const pg = fwd - c.len / 2 - player.r;
          if (pg < gap) { gap = pg; lv = 0; }
        }
      }
      // desired speed: limit, slower into turns and dead ends
      let v0 = lane.speed;
      if (c.next >= 0) {
        const ang = g.turnAngle(lane, g.lanes[c.next]);
        const vt = ang > 2.6 ? 2.5 : Math.max(3.5, lane.speed * (1 - ang / 2.2));
        v0 = Math.min(v0, Math.sqrt(vt * vt + 2 * 2.2 * Math.max(0, distEnd - 3)));
      }
      // IDM
      const s0 = 2.2, T = 1.3, a = 1.6, b = 2.4;
      const ss = s0 + Math.max(0, c.v * T + (c.v * (c.v - lv)) / (2 * Math.sqrt(a * b)));
      let acc = a * (1 - Math.pow(c.v / Math.max(v0, 0.1), 4) - Math.pow(ss / Math.max(gap, 0.1), 2));
      acc = Math.max(acc, -9);
      c.braking = acc < -0.8;
      c.v = Math.max(0, c.v + acc * dt);
      if (gap < 0.3) c.v = 0;
      c.wait = c.v < 0.3 ? c.wait + dt : 0;
      c.s += c.v * dt;

      // release a junction once clear of it
      if (c.reserved >= 0 && lane.from === c.reserved && c.s > 7) {
        if (this.reservations.get(c.reserved) === ci) this.reservations.delete(c.reserved);
        c.reserved = -1;
      }
      if (c.s >= L) {
        if (c.next < 0) {
          // drove off the edge of the map: come back in somewhere else
          this.respawn(ci);
          continue;
        }
        c.s -= L;
        c.lane = c.next;
        c.next = this.pickNext(c);
      }
      g.at(g.lanes[c.lane], c.s, tmp);
      c.x = tmp.x; c.y = tmp.y; c.h = tmp.h;
      let dh = c.h - c.vh;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      c.vh += dh * Math.min(1, dt * 7);
    }
    // stale reservations (car respawned or removed)
    for (const [n, ci] of this.reservations) {
      const c = this.cars[ci];
      if (!c || c.reserved !== n) this.reservations.delete(n);
    }
  }

  private respawn(ci: number) {
    const c = this.cars[ci];
    if (c.reserved >= 0 && this.reservations.get(c.reserved) === ci) this.reservations.delete(c.reserved);
    const pool = this.entries.length ? this.entries : this.g.lanes.map((l) => l.id);
    for (let tries = 0; tries < 10; tries++) {
      const lane = this.g.lanes[pool[Math.floor(Math.random() * pool.length)]];
      if (this.cars.some((o) => o !== c && o.lane === lane.id && o.s < 12)) continue;
      c.lane = lane.id; c.s = 0; c.v = lane.speed * 0.8; c.reserved = -1; c.wait = 0;
      c.next = this.pickNext(c);
      this.g.at(lane, 0, tmp);
      c.x = tmp.x; c.y = tmp.y; c.h = c.vh = tmp.h;
      return;
    }
    c.s = this.g.lanes[c.lane].length - 0.01;
    c.v = 0;
  }

  /** Cars as circles, for the player's collisions. */
  forEachCar(f: (x: number, y: number, h: number) => void) {
    for (const c of this.cars) f(c.x, c.y, c.vh);
  }

  render() {
    const m = this.meshes;
    const n = this.cars.length;
    const pos = new THREE.Vector3(), scl = new THREE.Vector3(1, 1, 1);
    const tailOn = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const c = this.cars[i];
      pos.set(c.x, this.terrain.heightAt(c.x, c.y), -c.y);
      this.q.setFromAxisAngle(this.up, c.vh);
      this.m4.compose(pos, this.q, scl);
      for (const k of ["body", "glass", "wheels", "head", "tail"] as const) m[k].setMatrixAt(i, this.m4);
      m.body.setColorAt(i, c.color);
      const t = c.braking ? 1 : this.night * 0.5;
      tailOn.setRGB(0.35 + 3.2 * t, 0.04 + 0.1 * t, 0.04 + 0.08 * t);
      m.tail.setColorAt(i, tailOn);
    }
    for (const k of ["body", "glass", "wheels", "head", "tail"] as const) {
      m[k].count = n;
      m[k].instanceMatrix.needsUpdate = true;
      if (m[k].instanceColor) m[k].instanceColor!.needsUpdate = true;
    }
  }
}

interface Walker {
  lane: number;
  s: number;
  v: number;
  x: number;
  y: number;
  h: number;
  phase: number;
  wait: number;
}

const SHIRTS = ["#2d4a7a", "#c94f3d", "#e8e2d4", "#3f6b45", "#222222", "#d9a441", "#7d5ba6", "#5d8fb3", "#a33b5b"];

/** People walking the OSM footpaths (and pavements along estate streets). */
export class Walkers {
  readonly group = new THREE.Group();
  private readonly people: Walker[] = [];
  private readonly body: THREE.InstancedMesh;
  private readonly legs: THREE.InstancedMesh;
  private readonly head: THREE.InstancedMesh;
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(private readonly g: Graph, private readonly terrain: Terrain, count: number) {
    const bodyGeo = new THREE.CapsuleGeometry(0.2, 0.55, 4, 8);
    bodyGeo.translate(0, 1.18, 0);
    const legGeo = new THREE.BoxGeometry(0.22, 0.8, 0.3);
    legGeo.translate(0, 0.4, 0);
    const headGeo = new THREE.SphereGeometry(0.13, 10, 8);
    headGeo.translate(0, 1.72, 0);
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const m = new THREE.InstancedMesh(geo, mat, count);
      m.castShadow = true;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    };
    this.body = mk(bodyGeo, new THREE.MeshStandardMaterial({ roughness: 0.8 }));
    this.legs = mk(legGeo, new THREE.MeshStandardMaterial({ color: 0x2b2f3a, roughness: 0.9 }));
    this.head = mk(headGeo, new THREE.MeshStandardMaterial({ color: 0xc99a7a, roughness: 0.7 }));
    const lanes = g.lanes.filter((l) => l.length > 6);
    const col = new THREE.Color();
    for (let i = 0; i < count && lanes.length; i++) {
      const lane = lanes[Math.floor(Math.random() * lanes.length)];
      this.people.push({
        lane: lane.id, s: Math.random() * lane.length, v: 1.1 + Math.random() * 0.5,
        x: 0, y: 0, h: 0, phase: Math.random() * 10, wait: 0,
      });
      this.body.setColorAt(i, col.set(SHIRTS[i % SHIRTS.length]));
    }
  }

  /** Fewer people out at night: show only the first `active` walkers. */
  update(dt: number, active: number, player: Mover | null) {
    const g = this.g;
    const n = Math.min(active, this.people.length);
    for (let i = 0; i < n; i++) {
      const p = this.people[i];
      let v = p.v;
      if (player) {
        const dx = player.x - p.x, dy = player.y - p.y;
        if (dx * dx + dy * dy < 16 && dx * Math.cos(p.h) + dy * Math.sin(p.h) > 0) v = 0; // wait for the car
      }
      p.s += v * dt;
      p.phase += v * dt * 2.4;
      const lane = g.lanes[p.lane];
      if (p.s >= lane.length) {
        const node = g.nodes[lane.to];
        const opts = node.out.filter((id) => g.lanes[id].edge !== lane.edge);
        const nextId = opts.length ? opts[Math.floor(Math.random() * opts.length)] : g.reverse(lane)?.id;
        if (nextId === undefined) {
          p.s = lane.length;
        } else {
          p.s -= lane.length;
          p.lane = nextId;
        }
      }
      g.at(g.lanes[p.lane], Math.min(p.s, g.lanes[p.lane].length), tmp);
      p.x = tmp.x; p.y = tmp.y;
      let dh = tmp.h - p.h;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      p.h += dh * Math.min(1, dt * 6);
    }
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3(1, 1, 1);
    const legScl = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < n; i++) {
      const p = this.people[i];
      const bob = Math.abs(Math.sin(p.phase)) * 0.04;
      pos.set(p.x, this.terrain.heightAt(p.x, p.y) + bob, -p.y);
      this.q.setFromAxisAngle(this.up, p.h);
      this.m4.compose(pos, this.q, scl);
      this.body.setMatrixAt(i, this.m4);
      this.head.setMatrixAt(i, this.m4);
      legScl.set(1 + Math.abs(Math.sin(p.phase)) * 1.2, 1, 1);
      this.m4.compose(pos, this.q, legScl);
      this.legs.setMatrixAt(i, this.m4);
    }
    for (const m of [this.body, this.legs, this.head]) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
    }
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
  }

  get total() {
    return this.people.length;
  }
}
