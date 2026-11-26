import type { Lane, RoadNetwork } from "./network";

/**
 * Microscopic traffic simulation on the OSM road graph.
 *
 * - Car following: Intelligent Driver Model (IDM) against the car ahead, possibly on the next lane.
 * - Traffic lights: fixed-time two-phase controllers (or a pedestrian phase for mid-block lights).
 * - Give way: minor roads wait at junctions while higher-ranked traffic is close.
 * - Demand: each road is kept near its share of the target for the time of day.
 * - Cars never pop in or out where you can see them. They appear off-screen, at the map edge or
 *   by pulling out of a dead end (driveway / car park), and they leave by driving off-screen, off
 *   the map edge or into a dead end. A car hidden behind a building or under a bridge is never
 *   removed there, so it always comes out the other side.
 */

export interface Car {
  id: number;
  lane: number;
  s: number;
  v: number;
  acc: number;
  next: number;
  len: number;
  width: number;
  height: number;
  kind: "car" | "van";
  color: string;
  /** Personal speed factor (some drive faster than others). */
  drive: number;
  /** 0..1 spawn/despawn fade. */
  presence: number;
  leaving: boolean;
  /** Pulling into a dead end to park: fades out once stopped. */
  parking: boolean;
  stuck: number;
  /** A parked car: static scenery, drawn like traffic but never simulated (no lights at night). */
  parked?: boolean;
  /** Smoothed render state (hides the small hop between lane offsets at junctions). */
  re: number; rn: number; rh: number; rhead: number;
  visible: number;
}

// IDM parameters
const A_MAX = 1.5, B_COMF = 2.2, S0 = 2.2, T_HEAD = 1.3;
const SIGNAL_CYCLE = 64;
/** Seconds to fade a car in when it pulls out of / out when it parks in a dead end. */
const PARK_FADE = 0.8;

const COLORS: [string, number][] = [
  ["#f3efe6", 26], ["#c9ccd1", 18], ["#8e939a", 14], ["#2e3136", 14], ["#3e5a7e", 7],
  ["#a33f3d", 6], ["#6f7f5a", 3], ["#d8b16e", 3], ["#5d6e92", 5], ["#e9dcc0", 4],
];
const COLOR_TOTAL = COLORS.reduce((a, [, w]) => a + w, 0);

export interface SimInputs {
  /** 0..1 demand (1 = weekday peak). */
  demand: number;
  /** Multiplier on desired speeds (weather). */
  speedFactor: number;
}

export class TrafficSim {
  cars: Car[] = [];
  private byLane: Car[][];
  /** Seconds the head car of each give-way lane has been waiting (drivers get less picky). */
  private yieldWait: Float64Array;
  private nextId = 1;
  private time = 0;
  private spawnClock = 0;
  private demandOverride: number | null = null;
  /** Scales how many cars are simulated (lower on phones). */
  densityScale = 1;
  /** Road classes currently above their share of the target (cars there may park). */
  private surplus = new Set<string>();
  private seed = 12345;
  /** Called when a vehicle leaves the simulation. */
  onRemove: ((c: Car) => void) | null = null;
  /** Is a ground point currently visible on screen? Set by the renderer; null = assume visible. */
  private viewProbe: ((e: number, n: number, h: number) => boolean) | null = null;

  constructor(readonly net: RoadNetwork) {
    this.byLane = net.lanes.map(() => []);
    this.yieldWait = new Float64Array(net.lanes.length);
  }

  setViewProbe(fn: ((e: number, n: number, h: number) => boolean) | null) {
    this.viewProbe = fn;
  }

  private seen(laneId: number, s: number): boolean {
    if (!this.viewProbe) return true;
    const p = this.net.sample(this.net.lanes[laneId], s);
    return this.viewProbe(p.e, p.n, p.h);
  }

  /** Feed a live congestion index (0..1+) instead of the typical profile; null to go back. */
  setDemandOverride(d: number | null) {
    this.demandOverride = d;
  }

  private rand() {
    // mulberry32: deterministic, so a given start looks the same every load
    let t = (this.seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  targetCount(demand: number): number {
    let total = 0;
    for (const ln of this.net.lanes) total += (ln.len / 1000) * ln.density;
    return Math.round(total * demand);
  }

  /** Signal aspect for a lane's stop line at the current sim time: 0 green, 1 amber, 2 red. */
  signalState(lane: Lane): number {
    if (!lane.signal) return 0;
    const ctrl = this.net.controllers[lane.signal.ctrl];
    const t = (this.time + ctrl.offset) % SIGNAL_CYCLE;
    if (ctrl.groups === 1) return t < 44 ? 0 : t < 47 ? 1 : 2;       // mid-block crossing: short pedestrian red
    const start = lane.signal.group === 0 ? 0 : 32;
    const local = (t - start + SIGNAL_CYCLE) % SIGNAL_CYCLE;
    return local < 28 ? 0 : local < 31 ? 1 : 2;
  }

  /** Populate the network immediately (no warm-up) for the given demand. */
  seedCars(inputs: SimInputs) {
    const demand = (this.demandOverride ?? inputs.demand) * this.densityScale;
    const weights = this.net.lanes.map((ln) => ln.len * ln.density);
    const sum = weights.reduce((a, b) => a + b, 0);
    const target = this.targetCount(demand);
    for (let k = 0, tries = 0; k < target && tries < target * 5; tries++) {
      let r = this.rand() * sum, i = 0;
      while (r > weights[i] && i < weights.length - 1) r -= weights[i++];
      const ln = this.net.lanes[i];
      const s = this.rand() * ln.len;
      if (this.spawn(ln.id, s, 1)) k++;
    }
  }

  private spawn(laneId: number, s: number, presence: number, v?: number): Car | null {
    const ln = this.net.lanes[laneId];
    for (const c of this.byLane[laneId]) if (Math.abs(c.s - s) < c.len + 8) return null;
    const van = this.rand() < 0.08;
    let r = this.rand() * COLOR_TOTAL, color = COLORS[0][0];
    for (const [c, w] of COLORS) { if ((r -= w) <= 0) { color = c; break; } }
    const p = this.net.sample(ln, s);
    const car: Car = {
      id: this.nextId++, lane: laneId, s, v: v ?? ln.vmax * 0.6, acc: 0, next: -1,
      len: van ? 5.2 : 4.1 + this.rand() * 0.6, width: van ? 2.0 : 1.8, height: van ? 2.1 : 1.45,
      kind: van ? "van" : "car", color: van ? "#f1efe9" : color,
      drive: 0.85 + this.rand() * 0.25, presence, leaving: false, parking: false, stuck: 0,
      re: p.e, rn: p.n, rh: p.h, rhead: p.head, visible: 1,
    };
    car.next = this.chooseNext(ln, car);
    this.cars.push(car);
    this.byLane[laneId].push(car);
    return car;
  }

  remove(c: Car) {
    const i = this.cars.indexOf(c);
    if (i >= 0) this.cars.splice(i, 1);
    const l = this.byLane[c.lane], j = l.indexOf(c);
    if (j >= 0) l.splice(j, 1);
    this.onRemove?.(c);
  }

  private chooseNext(ln: Lane, car: Car): number {
    if (ln.endsAtBoundary || !ln.out.length) return -1;
    if (car.leaving && ln.endsAtDeadEnd) return -1;   // park here
    const opts = ln.out.filter((id) => id !== ln.reverse);
    const cands = opts.length ? opts : ln.out;   // U-turn only at dead ends
    if (car.leaving && this.rand() < 0.85) {
      // head for the nearest way off the map
      let best = cands[0];
      for (const id of cands) if (this.net.lanes[id].exitDist < this.net.lanes[best].exitDist) best = id;
      return best;
    }
    let total = 0;
    const w = cands.map((id) => {
      const o = this.net.lanes[id];
      let turn = Math.abs(o.headStart - ln.headEnd);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      const straight = 1 + 2 * Math.max(0, Math.cos(turn));
      const cls = Math.pow(o.rank + 1, 1.6) * (o.cls === "service" ? 0.35 : 1);
      total += straight * cls;
      return straight * cls;
    });
    let r = this.rand() * total;
    for (let i = 0; i < cands.length; i++) if ((r -= w[i]) <= 0) return cands[i];
    return cands[cands.length - 1];
  }

  private turnSpeed(ln: Lane, next: number): number {
    if (next < 0) return Infinity;
    let turn = Math.abs(this.net.lanes[next].headStart - ln.headEnd);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn < 0.6) return Infinity;
    return turn > 2.4 ? 2.5 : turn > 1.2 ? 4.5 : 7;
  }

  /**
   * Is higher-priority traffic about to arrive at the junction at the end of `ln`?
   * Only moving cars count: a stopped car on the main road may be queued behind the very car
   * that is waiting to turn, and yielding to it would deadlock both.
   */
  private mustYield(ln: Lane): boolean {
    const accept = this.yieldWait[ln.id] > 6 ? 2 : 4;   // seconds of gap needed
    for (const id of this.net.incoming.get(ln.to) ?? []) {
      if (id === ln.id) continue;
      const o = this.net.lanes[id];
      if (o.rank <= ln.rank) continue;
      for (const c of this.byLane[id]) {
        const dist = o.len - c.s;
        if (c.v > 1 && dist < 40 && dist / c.v < accept) return true;
      }
    }
    return false;
  }

  step(dtReal: number, inputs: SimInputs) {
    const dt = Math.min(dtReal, 0.1);
    if (dt <= 0) return;
    this.time += dt;
    const demand = (this.demandOverride ?? inputs.demand) * this.densityScale;
    const lanes = this.net.lanes;

    for (const list of this.byLane) list.sort((a, b) => a.s - b.s);

    // ---- accelerations
    for (let li = 0; li < lanes.length; li++) {
      const ln = lanes[li], list = this.byLane[li];
      const aspect = ln.signal ? this.signalState(ln) : 0;
      const yieldHere = ln.yieldAtEnd && list.length > 0 && this.mustYield(ln);
      if (ln.yieldAtEnd) {
        const head = list[list.length - 1];
        this.yieldWait[li] = head && head.v < 0.5 && ln.len - head.s < 12 ? this.yieldWait[li] + dt : 0;
      }
      for (let k = 0; k < list.length; k++) {
        const c = list[k];
        const v0 = Math.max(1, ln.vmax * c.drive * inputs.speedFactor);
        // closest obstacle ahead: car on this lane, car on the next lane, a red light or a give-way line
        let gap = Infinity, vLead = 0;
        if (k + 1 < list.length) {
          const l = list[k + 1];
          gap = l.s - l.len - c.s;
          vLead = l.v;
        } else if (c.next >= 0) {
          const nl = this.byLane[c.next];
          if (nl.length) {
            let first = nl[0];
            for (const x of nl) if (x.s < first.s) first = x;
            gap = ln.len - c.s + first.s - first.len;
            vLead = first.v;
          }
        }
        const toEnd = ln.len - c.s;
        if (c.next < 0 && !ln.endsAtBoundary) {
          // parking at a dead end: stop just before its end
          const toPark = toEnd - 1.5;
          if (toPark < gap) { gap = Math.max(0.1, toPark); vLead = 0; }
        }
        if (ln.signal && aspect > 0) {
          const toStop = ln.signal.stopAt - c.s;
          // amber: stop only if we can do so comfortably
          if (toStop > -0.5 && (aspect === 2 || toStop > (c.v * c.v) / (2 * 3))) {
            if (toStop < gap) { gap = Math.max(0.1, toStop); vLead = 0; }
          }
        }
        if (yieldHere) {
          const toLine = toEnd - 3;
          if (toLine > -0.5 && toLine < gap) { gap = Math.max(0.1, toLine); vLead = 0; }
        }
        // slow for sharp turns into the next lane
        const vTurn = this.turnSpeed(ln, c.next);
        const vAllowed = Math.min(v0, Math.sqrt(vTurn * vTurn + 2 * B_COMF * Math.max(0, toEnd - 2)));
        const sStar = S0 + Math.max(0, c.v * T_HEAD + (c.v * (c.v - vLead)) / (2 * Math.sqrt(A_MAX * B_COMF)));
        const free = 1 - Math.pow(c.v / vAllowed, 4);
        const inter = gap === Infinity ? 0 : Math.pow(sStar / Math.max(gap, 0.1), 2);
        c.acc = Math.max(-9, A_MAX * (free - inter));
      }
    }

    // ---- integrate, hand over to the next lane, appear / leave out of sight
    const removed = new Set<Car>();
    for (const c of this.cars) {
      c.v = Math.max(0, c.v + c.acc * dt);
      c.s += c.v * dt;
      c.stuck = c.v < 0.2 && !this.waitingAtLight(c) ? c.stuck + dt : 0;
      if (c.parking) {
        c.presence -= dt / PARK_FADE;
        if (c.presence <= 0) removed.add(c);
        continue;
      }
      c.presence = Math.min(1, c.presence + dt / PARK_FADE);
      if (c.stuck > 60 && !c.leaving) this.makeLeave(c);   // rare gridlock: give up and head off
      if (c.stuck > 240) c.parking = true;                   // last resort for a true deadlock
      let ln = lanes[c.lane];
      // arrived at the dead end it is parking in (IDM keeps S0 before the stop line, so allow for it)
      if (c.next < 0 && !ln.endsAtBoundary && ln.len - c.s < S0 + 4 && c.v < 0.5) { c.parking = true; continue; }
      while (c.s >= ln.len) {
        if (c.next < 0) {
          if (ln.endsAtBoundary) removed.add(c);
          else { c.s = ln.len - 0.1; c.v = 0; c.parking = true; }
          break;
        }
        c.s -= ln.len;
        const from = this.byLane[c.lane];
        from.splice(from.indexOf(c), 1);
        c.lane = c.next;
        this.byLane[c.lane].push(c);
        ln = lanes[c.lane];
        c.next = this.chooseNext(ln, c);
        // surplus cars on side streets head off the map
        if (!c.leaving && (ln.cls === "service" || ln.cls === "residential") && this.surplus.has(ln.cls) && this.rand() < 0.4) {
          this.makeLeave(c);
        }
      }
      // leaving cars vanish the moment they are out of view (never while merely hidden on screen)
      if (c.leaving && !removed.has(c) && !c.parking && !this.seen(c.lane, c.s)) removed.add(c);
    }
    if (removed.size) {
      this.cars = this.cars.filter((c) => !removed.has(c));
      for (const c of removed) {
        const l = this.byLane[c.lane];
        const i = l.indexOf(c);
        if (i >= 0) l.splice(i, 1);
        this.onRemove?.(c);
      }
    }

    // ---- keep each road near its share of the target for the time of day
    this.spawnClock += dt;
    if (this.spawnClock >= 0.25) {
      this.spawnClock = 0;
      this.rebalance(demand);
    }
  }

  private rebalance(demand: number) {
    const lanes = this.net.lanes;
    const active = this.cars.filter((c) => !c.leaving);
    const target = this.targetCount(demand);
    const n = active.length;

    const laneCount = new Array<number>(lanes.length).fill(0);
    const clsCount = new Map<string, number>(), clsTarget = new Map<string, number>();
    for (const c of active) laneCount[c.lane]++;
    let deficitTotal = 0;
    const deficit = lanes.map((ln, i) => {
      const want = (ln.len / 1000) * ln.density * demand;
      clsTarget.set(ln.cls, (clsTarget.get(ln.cls) ?? 0) + want);
      clsCount.set(ln.cls, (clsCount.get(ln.cls) ?? 0) + laneCount[i]);
      const d = Math.max(0, want - laneCount[i]);
      deficitTotal += d;
      return d;
    });
    this.surplus.clear();
    for (const [cls, want] of clsTarget) if ((clsCount.get(cls) ?? 0) > want * 1.15 + 1) this.surplus.add(cls);

    if (n < target && deficitTotal > 0) {
      // fill the emptiest roads first, but only where nobody sees a car appear:
      // off-screen, at the map edge, or pulling out of a dead end
      const want = Math.min(6, 1 + Math.floor((target - n) / 12));
      for (let k = 0, made = 0; k < want * 4 && made < want; k++) {
        let r = this.rand() * deficitTotal, i = 0;
        while (r > deficit[i] && i < deficit.length - 1) r -= deficit[i++];
        const ln = lanes[i];
        const s = this.rand() * ln.len;
        let car: Car | null = null;
        if (!this.seen(ln.id, s)) car = this.spawn(ln.id, s, 1);
        else if (!this.seen(ln.id, 0)) car = this.spawn(ln.id, 0, 1);
        else if (ln.startsAtDeadEnd) car = this.spawn(ln.id, 0.5, 0, 0);
        if (car) made++;
      }
    } else if (n > target * 1.4) {
      // big drop in demand (e.g. scrubbing the clock to 3 am): send a few cars home
      const k = Math.ceil((n - target) / 20);
      for (let i = 0; i < k; i++) {
        const c = active[Math.floor(this.rand() * active.length)];
        if (c) this.makeLeave(c);
      }
    }
  }

  private makeLeave(c: Car) {
    c.leaving = true;
    c.next = this.chooseNext(this.net.lanes[c.lane], c);
  }

  private waitingAtLight(c: Car): boolean {
    const ln = this.net.lanes[c.lane];
    return (!!ln.signal && this.signalState(ln) > 0) || ln.yieldAtEnd;
  }

  /** Debug/telemetry snapshot. */
  stats() {
    let moving = 0, speed = 0;
    for (const c of this.cars) { if (c.v > 0.5) moving++; speed += c.v; }
    return { cars: this.cars.length, moving, meanKmh: this.cars.length ? (speed / this.cars.length) * 3.6 : 0 };
  }
}
