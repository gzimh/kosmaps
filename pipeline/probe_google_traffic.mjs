// Probe Google Routes API traffic for Prishtinë (Belgrade = covered control). Usage: GCP_MAPS_KEY=... node pipeline/probe_google_traffic.mjs
// Each request is a billed Routes "computeRoutes" call with traffic (~9 per run). Run at rush hour to see live data:
// "now" durations above the no-traffic baseline and SLOW / TRAFFIC_JAM speed intervals mean real-time coverage.
const KEY = process.env.GCP_MAPS_KEY;
const ROUTES = {
  "PR cross-city (Lakrishtë → Kodra e Diellit)": [[42.6430, 21.1390], [42.6640, 21.1730]],
  "PR Fushë Kosovë → centre (M-9)": [[42.6370, 21.0960], [42.6600, 21.1600]],
  "BG Terazije → Novi Beograd (control)": [[44.8125, 20.4612], [44.8075, 20.4170]],
};
const WHEN = { now: null, "Mon 08:15": "2026-11-23T07:15:00Z", "Mon 17:00": "2026-11-23T16:00:00Z" };
const sec = (d) => (d ? +d.replace("s", "") : null);
for (const [name, [o, d]] of Object.entries(ROUTES)) {
  for (const [label, dep] of Object.entries(WHEN)) {
    const body = {
      origin: { location: { latLng: { latitude: o[0], longitude: o[1] } } },
      destination: { location: { latLng: { latitude: d[0], longitude: d[1] } } },
      travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE_OPTIMAL", extraComputations: ["TRAFFIC_ON_POLYLINE"],
      ...(dep && { departureTime: dep }),
    };
    const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY,
        "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters,routes.travelAdvisory.speedReadingIntervals" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) { console.log(name, label, "HTTP", r.status, j.error?.status, (j.error?.message || "").slice(0, 160), JSON.stringify(j.error?.details?.map(x => x.reason || x["@type"]))); continue; }
    const rt = j.routes?.[0];
    if (!rt) { console.log(name, label, "no route", JSON.stringify(j).slice(0, 200)); continue; }
    const iv = rt.travelAdvisory?.speedReadingIntervals ?? [];
    const cats = iv.reduce((a, x) => ((a[x.speed || "?"] = (a[x.speed || "?"] || 0) + 1), a), {});
    const dyn = sec(rt.duration), stat = sec(rt.staticDuration);
    console.log(`${name} | ${label} | ${(rt.distanceMeters / 1000).toFixed(1)} km | traffic ${dyn}s vs no-traffic ${stat}s (${stat ? ((dyn / stat - 1) * 100).toFixed(0) : "?"}%) | intervals ${iv.length} ${JSON.stringify(cats)}`);
  }
}
