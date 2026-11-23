"""Turn the one-time Google harvest (traffic_harvest.json) into the static weekly profile the
traffic simulation reads: traffic_profile.json -> exported to public/data/ by export_web.py.

For each corridor, congestion is measured against its own quietest hour of the week (Google's
"static" duration is not true free flow: 3 am trips come in at ~0.6x of it):
    delay(h) = ratio(h) / min_week(ratio)          1.0 = free flow, 2.6 = trip takes 2.6x as long
The four corridors are averaged, then:
    demand(h) = ((delay - quiet) / (peak - quiet)) ** 0.75
                    0..~1, 1 = typical weekday peak (90th pct of weekday delays); `quiet` is the
                    week's 15th-percentile delay, so small, noisy night delays read as empty roads.
                    The exponent < 1 reflects that delay grows faster than traffic volume.
    speed(h)  = delay ** -0.35                      drivers' desired-speed factor; the rest of the
                                                    slowdown comes from the simulated queues
"""
import json
import statistics as st

H = json.load(open("traffic_harvest.json"))
rows = H["results"]
corridors = sorted({r["corridor"] for r in rows})
ratio = {(r["corridor"], r["weekday"], r["hour"]): r["duration"] / r["staticDuration"] for r in rows}
free = {c: min(v for (cc, _, _), v in ratio.items() if cc == c) for c in corridors}
delay = {(wd, h): st.mean(ratio[(c, wd, h)] / free[c] for c in corridors) for wd in range(7) for h in range(24)}

weekday_delays = sorted(delay[(wd, h)] for wd in range(1, 6) for h in range(24))
peak = weekday_delays[int(0.9 * (len(weekday_delays) - 1))]
all_delays = sorted(delay.values())
quiet = all_delays[int(0.15 * (len(all_delays) - 1))]
FLOOR = 0.05


def demand(d):
    return round(max(FLOOR, min(1.2, (max(0.0, d - quiet) / (peak - quiet)) ** 0.75)), 3)


profile = {
    "source": "Google Routes API predicted travel times (TRAFFIC_AWARE), harvested once; not live",
    "harvestedAt": H["harvestedAt"],
    "weekOf": H["weekStart"],
    "corridors": corridors,
    "sampleMinute": 15,
    "peakDelay": round(peak, 3),
    "quietDelay": round(quiet, 3),
    # index 0 = Sunday ... 6 = Saturday, 24 hourly values each (sampled at hh:15 local time)
    "demand": [[demand(delay[(wd, h)]) for h in range(24)] for wd in range(7)],
    "speed": [[round(min(1.0, delay[(wd, h)] ** -0.35), 3) for h in range(24)] for wd in range(7)],
}
json.dump(profile, open("traffic_profile.json", "w"), indent=1)

days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
print(f"traffic_profile.json: weekday peak delay {peak:.2f}x free flow, quiet level {quiet:.2f}x")
print("demand   " + "".join(f"{h:>5}" for h in range(24)))
for wd in [1, 2, 3, 4, 5, 6, 0]:
    print(f"{days[wd]}      " + "".join(f"{v:5.2f}" for v in profile["demand"][wd]))
