/** Kosovo uses Central European Time; Europe/Belgrade is the IANA zone for it. */
export const TIME_ZONE = "Europe/Belgrade";

export const formatMinutes = (m: number) => {
  const w = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(w / 60)).padStart(2, "0")}:${String(Math.floor(w % 60)).padStart(2, "0")}`;
};

/** Minutes since local midnight in Prishtinë, right now. */
export function localMinutesNow(): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

/** Day of the week in Prishtinë right now (0 = Sunday). */
export function localWeekdayNow(): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "short" }).format(new Date());
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}

/** Today's date at local Prishtinë time `m` (minutes since midnight). */
export function dateForMinutes(m: number): Date {
  return new Date(Date.now() + (m - localMinutesNow()) * 60000);
}
