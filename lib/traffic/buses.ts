import type { RoadNetwork } from "./network";
import type { RouteHighlight } from "./render";
import type { BusDrive, Car, TrafficSim } from "./sim";

/** public/data/buses.json, written by pipeline/build_buses.py. */
export interface BusesFile {
  source: string;
  lines: Record<string, BusLine>;
  variants: BusVariant[];
}

export interface BusLine {
  ref: string;
  name: string;
  color: string;
  source: "official" | "estimate";
  url?: string | null;
  note?: string;
  /** Official timetables: departures (HH:MM) per OSM route variant. */
  directions?: Record<string, { from: string; to: string; weekday: string[]; weekend: string[] }>;
  /** Estimated lines: one bus every N minutes between span[0] and span[1], both directions. */
  headwayMin?: number;
  span?: [string, string];
}

export interface BusVariant {
  id: number;
  ref: string;
  name: string | null;
  from: string | null;
  to: string | null;
  /** Route length (m). */
  length: number;
  /** All stops on the route, ordered; d = metres from the route start. */
  stops: { name: string; d: number; lat: number; lon: number }[];
  passes: {
    lanes: [number, boolean][];
    s0: number;
    sEnd: number;
    dStart: number;
    dEnd: number;
    entersAtEdge: boolean;
    leavesAtEdge: boolean;
    stops: { stop: number; lane: number; s: number }[];
  }[];
}

interface Pass {
  variant: BusVariant;
  line: BusLine;
  lanes: number[];
  /** Cumulative lane-path length at the start of each lane. */
  laneStart: number[];
  s0: number;
  pathEnd: number;
  dStart: number;
  dEnd: number;
  entersAtEdge: boolean;
  stops: { stop: number; at: number }[];
  /** Matching points between lane-path position and route distance (pass ends + every stop). */
  anchorPos: number[];
  anchorD: number[];
}

/** Piecewise-linear lookup in increasing x[] -> y[]. */
function interp(x: number[], y: number[], v: number): number {
  if (v <= x[0]) return y[0] + (v - x[0]);
  for (let i = 1; i < x.length; i++) {
    if (v <= x[i]) return y[i - 1] + ((v - x[i - 1]) / Math.max(1e-6, x[i] - x[i - 1])) * (y[i] - y[i - 1]);
  }
  return y[y.length - 1] + (v - x[x.length - 1]);
}

/** One scheduled run of a route variant. */
interface Trip {
  key: string;
  pass: Pass;
  /** Departure from the first terminus, minutes since local midnight (may be < 0 or > 1440). */
  dep: number;
}

export interface BusInfo {
  car: Car;
  line: BusLine;
  variant: BusVariant;
  /** Scheduled time (minutes) at every stop of the route. */
  times: number[];
  /** Index (into variant.stops) of the next stop. */
  nextStop: number;
  /** Positive = late, minutes. */
  lateMin: number;
  dwelling: boolean;
  departure: number;
  headwayNow: number | null;
  firstLast: [number, number] | null;
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

const MIN_DWELL_S = 12;

/**
 * Buses that run to the timetable. Each trip's schedule gives a time at every stop (timetables
 * only publish terminus departures, so running times use a typical urban bus speed + dwell). In the
 * map a bus is a vehicle in the traffic simulation: it picks its speed so it reaches the next stop
 * on time, never faster than traffic and the speed limit allow, and holds at a stop if early.
 */
export class BusSystem {
  private passes: Pass[] = [];
  private live = new Map<string, Car>();
  private byCar = new Map<number, { trip: Trip; dwell: number; stopIdx: number }>();
  private clock = 0;
  private lastUi: number | null = null;
  /** "Play a day": the map clock runs far faster than any bus could follow (see update). */
  private timelapse = false;
  private speedMpm: number;
  private dwellMin: number;

  constructor(readonly file: BusesFile, private net: RoadNetwork, private sim: TrafficSim, runningSpeedKmh = 17, dwellS = 18) {
    this.speedMpm = (runningSpeedKmh * 1000) / 60;
    this.dwellMin = dwellS / 60;
    for (const v of file.variants) {
      const line = file.lines[v.ref];
      if (!line) continue;
      for (const p of v.passes) {
        const lanes = p.lanes.map(([li, fwd]) => net.linkLanes[li][fwd ? 0 : 1]);
        if (lanes.some((l) => l < 0)) continue;
        const laneStart: number[] = [];
        let acc = 0;
        for (const l of lanes) { laneStart.push(acc); acc += net.lanes[l].len; }
        const lastLen = net.lanes[lanes[lanes.length - 1]].len;
        const pathEnd = laneStart[lanes.length - 1] + Math.min(p.sEnd, lastLen);
        const stops = p.stops.map((q) => ({ stop: q.stop, at: laneStart[q.lane] + Math.min(q.s, net.lanes[lanes[q.lane]].len - 1) }));
        // the lane path and the OSM route differ in length; tie them together at the ends and at
        // every stop so a bus's position and the stop times always agree
        const anchorPos = [p.s0], anchorD = [p.dStart];
        for (const q of stops) {
          const d = v.stops[q.stop].d;
          if (q.at > anchorPos[anchorPos.length - 1] + 1 && d > anchorD[anchorD.length - 1] + 1 && q.at < pathEnd - 1 && d < p.dEnd - 1) {
            anchorPos.push(q.at);
            anchorD.push(d);
          }
        }
        anchorPos.push(pathEnd);
        anchorD.push(p.dEnd);
        this.passes.push({
          variant: v, line, lanes, laneStart, s0: p.s0, pathEnd,
          dStart: p.dStart, dEnd: p.dEnd, entersAtEdge: p.entersAtEdge, stops, anchorPos, anchorD,
        });
      }
    }
    sim.onRemove = (c) => this.forget(c);
  }

  /** Lines that actually run through the map. */
  get lineRefs(): string[] {
    return [...new Set(this.passes.map((p) => p.line.ref))];
  }

  // ------------------------------------------------------------------ timetable
  private departures(line: BusLine, variantId: number, weekend: boolean): number[] {
    const dir = line.directions?.[String(variantId)];
    if (dir) return (weekend ? dir.weekend : dir.weekday).map(toMin);
    if (line.headwayMin && line.span) {
      const out: number[] = [];
      for (let t = toMin(line.span[0]); t <= toMin(line.span[1]); t += line.headwayMin) out.push(t);
      return out;
    }
    return [];
  }

  /** Scheduled time (minutes) at distance d along the route, for a trip leaving at `dep`. */
  private timeAt(v: BusVariant, dep: number, d: number): number {
    let stopsBefore = 0;
    for (const s of v.stops) if (s.d < d - 1) stopsBefore++;
    return dep + d / this.speedMpm + stopsBefore * this.dwellMin;
  }

  private stopTimes(v: BusVariant, dep: number) {
    return v.stops.map((s) => this.timeAt(v, dep, s.d));
  }

  /** Trips whose pass through the map is scheduled around `clock` (yesterday's late trips too). */
  private activeTrips(clock: number, weekday: number): Trip[] {
    const out: Trip[] = [];
    for (const [dayOff, wd] of [[0, weekday], [-1440, (weekday + 6) % 7]] as const) {
      const weekend = wd === 0 || wd === 6;
      for (const p of this.passes) {
        for (const dep0 of this.departures(p.line, p.variant.id, weekend)) {
          const dep = dep0 + dayOff;
          const tIn = this.timeAt(p.variant, dep, p.dStart);
          const tOut = this.timeAt(p.variant, dep, p.dEnd);
          if (clock >= tIn - 0.05 && clock <= tOut + 3) out.push({ key: `${p.variant.id}:${p.dStart}:${dep}`, pass: p, dep });
        }
      }
    }
    return out;
  }

  /** Where the schedule says the bus should be (lane-path position) at `clock`. */
  private scheduledPos(trip: Trip, clock: number): number {
    const p = trip.pass, v = p.variant;
    // invert timeAt by bisection on distance
    let lo = p.dStart, hi = p.dEnd;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (this.timeAt(v, trip.dep, mid) < clock) lo = mid; else hi = mid;
    }
    return interp(p.anchorD, p.anchorPos, lo);
  }

  // ------------------------------------------------------------------ per frame
  /**
   * @param dtSim simulated seconds this frame (faster than real time during a timelapse)
   * @param uiMinutes the map's clock (minutes since local midnight); a jump re-seeds the buses
   * @param weekday 0 = Sunday
   * @param timelapse "Play a day" is running: the clock races ahead (24 h in 30 s), so instead of
   *   keeping exact times each route keeps as many buses as its timetable has on it at that hour,
   *   driving at traffic speed; when the timelapse ends, buses are put back on their schedule
   */
  update(dtSim: number, uiMinutes: number, weekday: number, timelapse = false) {
    this.weekday = weekday;
    if (timelapse) {
      this.timelapse = true;
      this.lastUi = uiMinutes;
      this.clock = uiMinutes;
      this.updateTimelapse(weekday);
      for (const c of this.live.values()) this.drive(c, dtSim);
      return;
    }
    const leftTimelapse = this.timelapse;
    this.timelapse = false;
    const jumped = leftTimelapse || this.lastUi === null || Math.abs(uiMinutes - this.lastUi) > 1.5;
    this.lastUi = uiMinutes;
    if (jumped) {
      this.clock = uiMinutes;
      for (const c of [...this.live.values()]) this.sim.remove(c);
    } else {
      this.clock += dtSim / 60;
    }

    for (const trip of this.activeTrips(this.clock, weekday)) {
      if (this.live.has(trip.key)) continue;
      const p = trip.pass;
      const tIn = this.timeAt(p.variant, trip.dep, p.dStart);
      const tOut = this.timeAt(p.variant, trip.dep, p.dEnd);
      if (this.clock > tOut) continue;
      let pos: number;
      if (jumped) pos = this.scheduledPos(trip, this.clock);       // time jump: put it where it should be
      else if (this.clock - tIn < 1) pos = p.s0;                    // normal: enter at the start of the pass
      else continue;                                                // missed its entry; don't pop in mid-map
      // entering at the map edge is out of sight; a mid-map terminus start fades in at its stop
      this.spawn(trip, pos, !jumped && !p.entersAtEdge);
    }

    for (const c of this.live.values()) this.drive(c, dtSim);
  }

  /**
   * Timelapse: keep as many buses in the map as the timetable has on these streets right now.
   * A bus takes ~10 real seconds to cross the map while the clock races through hours, so buses
   * are counted against the total (not per trip); new ones go to the routes most short of theirs.
   */
  private updateTimelapse(weekday: number) {
    const want = new Map<Pass, Trip[]>();
    let wantTotal = 0;
    for (const trip of this.activeTrips(this.clock, weekday)) {
      const p = trip.pass;
      const tIn = this.timeAt(p.variant, trip.dep, p.dStart), tOut = this.timeAt(p.variant, trip.dep, p.dEnd);
      if (this.clock < tIn || this.clock > tOut) continue;    // strictly on its way through the map
      const l = want.get(p) ?? [];
      l.push(trip);
      want.set(p, l);
      wantTotal++;
    }
    if (this.byCar.size >= wantTotal) return;
    const have = new Map<Pass, number>();
    for (const st of this.byCar.values()) have.set(st.trip.pass, (have.get(st.trip.pass) ?? 0) + 1);
    let best: Pass | null = null, bestGap = 0;
    for (const [pass, trips] of want) {
      const gap = trips.length - (have.get(pass) ?? 0);
      if (gap > bestGap) { best = pass; bestGap = gap; }
    }
    if (!best) return;
    const trip = want.get(best)!.find((t) => !this.live.has(t.key));
    // enter at the start of the pass (the map edge), one at a time, so buses never pop in
    const blocked = this.sim.cars.some((c) => c.kind === "bus" && c.lane === best.lanes[0] && c.s < 30);
    if (trip && !blocked) this.spawn(trip, best.s0, !best.entersAtEdge);
  }

  private spawn(trip: Trip, pos: number, fadeIn: boolean) {
    const p = trip.pass;
    let idx = 0;
    while (idx + 1 < p.lanes.length && p.laneStart[idx + 1] <= pos) idx++;
    const s = Math.max(0, pos - p.laneStart[idx]);
    const drive: BusDrive = { route: p.lanes, idx, vCap: null, stopAt: null };
    const stopIdx = p.stops.findIndex((q) => q.at >= pos - 1);
    const car = this.sim.addBus(drive, s, 6, p.line.color, p.line.ref, fadeIn ? 0 : 1);
    this.live.set(trip.key, car);
    this.byCar.set(car.id, { trip, dwell: 0, stopIdx: stopIdx < 0 ? p.stops.length : stopIdx });
  }

  private forget(c: Car) {
    const st = this.byCar.get(c.id);
    if (!st) return;
    this.byCar.delete(c.id);
    this.live.delete(st.trip.key);
  }

  private posOf(c: Car, p: Pass) {
    return p.laneStart[c.bus!.idx] + c.s;
  }

  /** Schedule controller: speed to reach the next stop on time, then dwell / hold there. */
  private drive(c: Car, dt: number) {
    const st = this.byCar.get(c.id)!;
    const p = st.trip.pass, v = p.variant, bus = c.bus!;
    const pos = this.posOf(c, p);
    const next = p.stops[st.stopIdx];
    if (!next) {
      bus.stopAt = null;
      bus.vCap = null;
      return;
    }
    const tStop = this.timelapse ? -Infinity : this.timeAt(v, st.trip.dep, v.stops[next.stop].d);
    const dist = next.at - pos;
    const lane = p.lanes.findIndex((_, i) => p.laneStart[i] + this.net.lanes[p.lanes[i]].len > next.at);
    bus.stopAt = { lane: p.lanes[Math.max(0, lane)], s: next.at - p.laneStart[Math.max(0, lane)] };

    if (dist < 3 && c.v < 0.4) {
      // at the stop: let passengers on/off, and hold until the scheduled time if early
      st.dwell += dt;
      bus.vCap = 0;
      if (st.dwell >= MIN_DWELL_S && this.clock >= tStop) {
        st.stopIdx++;
        st.dwell = 0;
        bus.stopAt = null;
      }
      return;
    }
    // drive: aim to arrive exactly on time; never slower than 4 m/s, never faster than allowed
    const tLeft = (tStop - this.clock) * 60;
    bus.vCap = tLeft > 2 ? Math.max(4, Math.min(16, dist / tLeft)) : null;
  }

  // ------------------------------------------------------------------ info for the UI
  info(carId: number): BusInfo | null {
    const st = this.byCar.get(carId);
    const car = this.sim.cars.find((c) => c.id === carId);
    if (!st || !car) return null;
    const { trip } = st, p = trip.pass, v = p.variant;
    const times = this.stopTimes(v, trip.dep);
    const pos = this.posOf(car, p);
    const nextStop = p.stops[st.stopIdx]?.stop ?? v.stops.findIndex((s) => s.d > p.dEnd);
    // lateness: scheduled time at the bus's current spot vs now
    const lateMin = this.clock - this.timeAt(v, trip.dep, interp(p.anchorPos, p.anchorD, pos));
    const weekend = this.weekendNow();
    const deps = this.departures(p.line, v.id, weekend);
    const nowDep = deps.filter((d) => Math.abs(d - trip.dep) < 90).sort((a, b) => a - b);
    const i = nowDep.indexOf(trip.dep);
    const headwayNow = i > 0 ? trip.dep - nowDep[i - 1] : i >= 0 && i + 1 < nowDep.length ? nowDep[i + 1] - trip.dep : null;
    return {
      car, line: p.line, variant: v, times, nextStop: nextStop < 0 ? v.stops.length - 1 : nextStop,
      lateMin, dwelling: st.dwell > 0, departure: trip.dep, headwayNow,
      firstLast: deps.length ? [deps[0], deps[deps.length - 1]] : null,
    };
  }

  private weekday = 1;
  setWeekday(wd: number) { this.weekday = wd; }
  private weekendNow() { return this.weekday === 0 || this.weekday === 6; }

  /** Lane path + in-map stop positions of a bus's route (for highlighting it on the map). */
  routeOf(carId: number): RouteHighlight | null {
    const st = this.byCar.get(carId);
    if (!st) return null;
    const p = st.trip.pass;
    return { lanes: p.lanes, stops: p.stops.map((q) => ({ name: p.variant.stops[q.stop].name, at: q.at })), laneStart: p.laneStart, color: p.line.color };
  }

  get now() { return this.clock; }
}
