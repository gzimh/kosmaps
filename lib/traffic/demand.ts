/**
 * How busy the roads are, 0..1 (1 = typical weekday peak).
 *
 * No traffic provider publishes live flow for Kosovo (TomTom, HERE and Azure Maps don't cover it;
 * Esri has historical speeds only), so this is a hand-tuned typical-week profile for Prishtinë:
 * a sharp morning peak, a long busy afternoon and a quiet night. A live source can override it
 * via TrafficSim.setDemandOverride().
 */

// Weekday demand at the start of each hour, 00:00 .. 23:00.
const WEEKDAY = [
  0.12, 0.07, 0.05, 0.04, 0.05, 0.12, 0.35, 0.8, 1.0, 0.85, 0.75, 0.75,
  0.8, 0.82, 0.88, 0.95, 1.0, 0.98, 0.9, 0.8, 0.65, 0.5, 0.35, 0.2,
];
// Saturdays are busy late morning to evening; Sundays are quiet with an evening out.
const SATURDAY = [
  0.18, 0.12, 0.08, 0.05, 0.04, 0.06, 0.12, 0.25, 0.4, 0.55, 0.65, 0.72,
  0.75, 0.75, 0.72, 0.72, 0.75, 0.78, 0.8, 0.78, 0.7, 0.6, 0.45, 0.3,
];
const SUNDAY = [
  0.22, 0.14, 0.09, 0.05, 0.04, 0.05, 0.08, 0.14, 0.22, 0.32, 0.42, 0.5,
  0.55, 0.55, 0.52, 0.52, 0.56, 0.62, 0.66, 0.64, 0.55, 0.42, 0.3, 0.2,
];

/** Demand for local Prishtinë time (minutes since midnight) and weekday (0 = Sunday). */
export function typicalDemand(minutes: number, weekday: number): number {
  const table = weekday === 0 ? SUNDAY : weekday === 6 ? SATURDAY : WEEKDAY;
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), t = (m % 60) / 60;
  return table[h] + (table[(h + 1) % 24] - table[h]) * t;
}

/** Weather effect: people drive slower in rain and snow, and a bit less in heavy snow. */
export function weatherEffect(rain: number, snow: number) {
  return {
    speed: 1 - 0.15 * rain - 0.3 * snow,
    demand: 1 - 0.2 * snow,
  };
}

/**
 * Weekly profile baked once from Google's predicted travel times (pipeline/harvest_traffic.mjs +
 * build_traffic_profile.py), shipped as public/data/traffic_profile.json. Nothing is fetched from
 * Google at runtime.
 */
export interface TrafficProfile {
  source: string;
  weekOf: string;
  /** Minute past the hour at which each hourly value was sampled. */
  sampleMinute: number;
  /** [weekday 0 = Sunday][hour] → 0..~1.2 demand (1 = typical weekday peak). */
  demand: number[][];
  /** [weekday][hour] → desired-speed factor (≤ 1). */
  speed: number[][];
}

/** Profile values at a local time, linearly interpolated between hourly samples (wraps over the week). */
export function profileAt(p: TrafficProfile, minutes: number, weekday: number) {
  const x = (weekday * 1440 + minutes - p.sampleMinute) / 60;     // hours since Sunday hh:sample
  const i0 = Math.floor(x), t = x - i0;
  const at = (table: number[][], i: number) => {
    const k = ((i % 168) + 168) % 168;
    return table[Math.floor(k / 24)][k % 24];
  };
  const lerp = (table: number[][]) => at(table, i0) + (at(table, i0 + 1) - at(table, i0)) * t;
  return { demand: lerp(p.demand), speed: lerp(p.speed) };
}
