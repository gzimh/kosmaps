// ONE-TIME harvest of Google's predicted traffic for the map's main corridors, hour by hour for a
// typical week. The result feeds build_traffic_profile.py; the website itself never calls Google.
//
// Usage (from pipeline/): GCP_MAPS_KEY=... node harvest_traffic.mjs [weekStartLocalDate=2026-11-30]
// Cost: corridors x 7 days x 24 hours billed Routes "computeRoutes" calls (4 x 168 = 672).
// The week must be in the future (Google predicts from historical patterns for future departures)
// and should avoid public holidays (e.g. 28 Nov, Flag Day).
// Output: traffic_harvest.json (git-ignored: it is Google-derived data).
import fs from "node:fs";

const KEY = process.env.GCP_MAPS_KEY;
if (!KEY) { console.error("Set GCP_MAPS_KEY"); process.exit(1); }
const WEEK_START = process.argv[2] || "2026-11-30";   // a Monday
const UTC_OFFSET_H = 1;                              // CET in winter; use 2 for a CEST (summer) week
const CONCURRENCY = 4;

// Corridors through the map, both carriageways of the two boulevards. Waypoints are [[lat, lng], heading];
// headings make Google snap to the correct carriageway. Derived from OSM (roads.json) and checked by
// drawing Google's returned polylines over the mosaic.
const CORRIDORS = {
  deshmoret_N: { origin: [[42.64776, 21.15758], 274], via: [[[42.650332, 21.158322], 11]], dest: [[42.654998, 21.159584], 11] },
  deshmoret_S: { origin: [[42.659, 21.16061], 191], via: [[[42.655108, 21.159473], 191], [[42.650207, 21.15817], 191]], dest: [[42.64776, 21.15758], 94] },
  klinton_W: { origin: [[42.65596, 21.16249], 281], via: [[[42.655738, 21.158674], 276]], dest: [[42.65497, 21.155091], 249] },
  klinton_E: { origin: [[42.65241, 21.14509], 56], via: [[[42.654824, 21.154911], 69]], dest: [[42.655625, 21.158834], 100] },
};

const wp = ([[lat, lng], heading], via) => ({ location: { latLng: { latitude: lat, longitude: lng }, heading }, ...(via && { via: true }) });
const sec = (d) => (d ? Number(d.replace("s", "")) : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function query(c, departureTime) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY, "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters" },
      body: JSON.stringify({
        origin: wp(c.origin), destination: wp(c.dest), intermediates: c.via.map((v) => wp(v, true)),
        travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE", departureTime,
      }),
    });
    if (r.status === 429 || r.status >= 500) { await sleep(1000 * 2 ** attempt); continue; }
    const j = await r.json();
    const rt = j.routes?.[0];
    if (!r.ok || !rt) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    return { duration: sec(rt.duration), staticDuration: sec(rt.staticDuration), distance: rt.distanceMeters };
  }
  throw new Error("gave up after retries");
}

const jobs = [];
const start = new Date(`${WEEK_START}T00:00:00Z`);
for (const [name, c] of Object.entries(CORRIDORS)) {
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const t = new Date(start.getTime() + ((day * 24 + hour - UTC_OFFSET_H) * 3600 + 15 * 60) * 1000); // hh:15 local
      if (t.getTime() < Date.now() + 10 * 60 * 1000) throw new Error(`departure ${t.toISOString()} is not in the future`);
      // weekday 0 = Sunday, matching JS Date.getDay(); the harvest week starts on a Monday
      jobs.push({ name, c, weekday: (day + 1) % 7, hour, departureTime: t.toISOString() });
    }
  }
}

console.log(`${jobs.length} requests for week of ${WEEK_START}...`);
const results = [];
let next = 0, done = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < jobs.length) {
    const j = jobs[next++];
    const res = await query(j.c, j.departureTime);
    results.push({ corridor: j.name, weekday: j.weekday, hour: j.hour, departureTime: j.departureTime, ...res });
    if (++done % 50 === 0) console.log(`  ${done}/${jobs.length}`);
  }
}));
results.sort((a, b) => a.corridor.localeCompare(b.corridor) || a.weekday - b.weekday || a.hour - b.hour);
fs.writeFileSync("traffic_harvest.json", JSON.stringify({ weekStart: WEEK_START, utcOffsetH: UTC_OFFSET_H, harvestedAt: new Date().toISOString(), corridors: CORRIDORS, results }, null, 1));
console.log(`saved traffic_harvest.json (${results.length} rows)`);
