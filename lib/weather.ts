import type { Weather } from "./types";

const WMO: Record<number, string> = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "fog",
  51: "drizzle", 53: "drizzle", 55: "drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
  66: "freezing rain", 67: "freezing rain", 71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "showers", 81: "showers", 82: "heavy showers", 85: "snow showers", 86: "snow showers",
  95: "thunderstorm", 96: "thunderstorm", 99: "thunderstorm",
};

/** Current weather + PM2.5 from Open-Meteo (no key needed), mapped to 0..1 shader inputs. */
export async function fetchWeather(lat: number, lon: number): Promise<Weather> {
  const [f, a] = await Promise.all([
    fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        "&current=temperature_2m,precipitation,rain,snowfall,snow_depth,weather_code&timezone=auto",
    ).then((r) => r.json()),
    fetch(
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm2_5,european_aqi`,
    ).then((r) => r.json()),
  ]);
  const c = f.current;
  const wet = c.rain || c.precipitation || 0;
  return {
    temp: c.temperature_2m,
    desc: WMO[c.weather_code] || `weather ${c.weather_code}`,
    rain: wet > 0 ? Math.min(1, 0.35 + wet / 4) : 0,
    snow: Math.max(Math.min(1, (c.snow_depth || 0) / 0.05), c.snowfall > 0 ? 0.6 : 0),
    pm: a.current?.pm2_5 ?? 10,
  };
}
