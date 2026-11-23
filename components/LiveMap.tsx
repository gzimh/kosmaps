"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BuildingOverlay, BuildingPicker } from "@/lib/map/buildings";
import { HeightField } from "@/lib/map/heightfield";
import { TiledData, TileLoader } from "@/lib/map/tiles";
import { MapRenderer } from "@/lib/map/renderer";
import { lightingFor, sunElevation } from "@/lib/sun";
import { dateForMinutes, formatMinutes, localMinutesNow, localWeekdayNow } from "@/lib/time";
import { profileAt, typicalDemand, weatherEffect, type TrafficProfile } from "@/lib/traffic/demand";
import { RoadNetwork, type RoadsFile } from "@/lib/traffic/network";
import { TrafficRenderer } from "@/lib/traffic/render";
import { TrafficSim } from "@/lib/traffic/sim";
import type { BuildingsFile, Conditions, MapMeta, Weather } from "@/lib/types";
import { fetchWeather } from "@/lib/weather";
import { BusSystem, type BusesFile, type BusInfo } from "@/lib/traffic/buses";
import BuildingCard from "./BuildingCard";
import BusCard from "./BusCard";
import ControlPanel from "./ControlPanel";
import styles from "./LiveMap.module.css";

const DATA_URL = "/data";
const PLAY_MINUTES_PER_SECOND = 48; // a full day in 30 s
/** Traffic runs this many times faster than real time while playing a day (a timelapse). */
const TIMELAPSE_SPEED = 25;
/** Simulated seconds advanced per substep (keeps car following stable at high speed). */
const SIM_SUBSTEP = 0.1;
const WEATHER_REFRESH_MS = 10 * 60 * 1000;
const CLOCK_REFRESH_MS = 30 * 1000;
const CLICK_SLOP_PX = 5;

type LoadState = { kind: "loading" } | { kind: "missing" } | { kind: "error"; message: string } | { kind: "ready" };

const smogFromPm = (pm: number) => Math.min(1, Math.max(0, (pm - 12) / 160));

export default function LiveMap() {
  const mapCanvas = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<MapRenderer | null>(null);
  const picker = useRef<BuildingPicker | null>(null);

  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [meta, setMeta] = useState<MapMeta | null>(null);
  const [buildings, setBuildings] = useState<BuildingsFile | null>(null);
  const [conditions, setConditions] = useState<Conditions>({ minutes: 0, rain: 0, snow: 0, pm: 10 });
  const [live, setLive] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [weather, setWeather] = useState<Weather | null>(null);
  const [weatherFailed, setWeatherFailed] = useState(false);
  const [selected, setSelected] = useState(0);
  const [panelOpen, setPanelOpen] = useState(true);
  const [trafficAvailable, setTrafficAvailable] = useState(false);
  const [trafficOn, setTrafficOn] = useState(true);
  const [carCount, setCarCount] = useState(0);
  const [trafficSource, setTrafficSource] = useState<"google" | "typical">("typical");
  const [busCount, setBusCount] = useState(0);
  const [busInfo, setBusInfo] = useState<{ info: BusInfo; gone: boolean } | null>(null);
  const trafficRef = useRef<TrafficRenderer | null>(null);
  const busesRef = useRef<BusSystem | null>(null);
  const selectedBusRef = useRef(0);

  // Mirrors of state for the animation loop and event handlers (which must not re-subscribe every change).
  const conditionsRef = useRef(conditions);
  const liveRef = useRef(live);
  const playingRef = useRef(playing);
  const weatherRef = useRef(weather);
  const selectedRef = useRef(selected);
  const buildingsRef = useRef(buildings);
  const hoveredRef = useRef(0);
  const trafficOnRef = useRef(trafficOn);
  useEffect(() => { trafficOnRef.current = trafficOn; }, [trafficOn]);
  useEffect(() => { conditionsRef.current = conditions; }, [conditions]);
  useEffect(() => { liveRef.current = live; }, [live]);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { weatherRef.current = weather; }, [weather]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { buildingsRef.current = buildings; }, [buildings]);

  const applyLive = useCallback((w: Weather | null) => {
    setConditions((c) => ({
      ...c,
      minutes: localMinutesNow(),
      ...(w && { rain: w.rain, snow: w.snow, pm: w.pm }),
    }));
  }, []);

  /** Select a bus (by car id), or 0 to clear. Deselects any building. */
  const selectBus = useCallback((carId: number) => {
    selectedBusRef.current = carId;
    const buses = busesRef.current;
    const info = carId && buses ? buses.info(carId) : null;
    trafficRef.current?.setSelection(info ? carId : null, info && buses ? buses.routeOf(carId) : null);
    setBusInfo(info ? { info, gone: false } : null);
    if (!info) selectedBusRef.current = 0;
  }, []);

  const select = useCallback((id: number) => {
    if (id) selectBus(0);
    const b = id ? buildingsRef.current?.buildings[id - 1] : undefined;
    const next = b ? id : 0;
    selectedRef.current = next;
    setSelected(next);
    history.replaceState(null, "", b ? `#b=${b.osm}` : location.pathname + location.search);
  }, [selectBus]);

  // ------------------------------------------------------------------ setup, data, render loop
  useEffect(() => {
    const canvas = mapCanvas.current!;
    const ov = overlayCanvas.current!;
    let cancelled = false;
    let raf = 0;
    const timers: ReturnType<typeof setInterval>[] = [];
    const cleanups: (() => void)[] = [];

    let view: MapRenderer;
    try {
      view = new MapRenderer(canvas);
    } catch (e) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reporting a one-off init failure
      setLoad({ kind: "error", message: (e as Error).message });
      return;
    }
    renderer.current = view;

    (async () => {
      const metaRes = await fetch(`${DATA_URL}/meta.json`).catch(() => null);
      if (cancelled) return;
      if (!metaRes?.ok) return setLoad({ kind: "missing" });
      const m: MapMeta = await metaRes.json();
      const L = m.layers;
      if (!m.pyramid) return setLoad({ kind: "missing" });   // an export from before tiling
      // imagery and data layers stream in as tiles; only the small JSON files load up front
      const loader = new TileLoader(8);
      view.setPyramid(m.size, m.pyramid, `${DATA_URL}/tiles`, loader);
      const [bf, roads, profile] = await Promise.all([
        fetch(`${DATA_URL}/${L.buildings}`).then((r) => r.json() as Promise<BuildingsFile>),
        L.roads ? fetch(`${DATA_URL}/${L.roads}`).then((r) => r.json() as Promise<RoadsFile>) : null,
        L.trafficProfile
          ? fetch(`${DATA_URL}/${L.trafficProfile}`).then((r) => (r.ok ? (r.json() as Promise<TrafficProfile>) : null)).catch(() => null)
          : null,
      ]);
      const busesFile: (BusesFile & { runningSpeedKmh?: number; dwellS?: number }) | null = L.buses
        ? await fetch(`${DATA_URL}/${L.buses}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
        : null;
      if (cancelled) return;

      const idTiles = new TiledData(loader, `${DATA_URL}/tiles/idmap`, m.data.idmap);
      picker.current = new BuildingPicker(idTiles);
      const heightTiles = m.data.height ? new TiledData(loader, `${DATA_URL}/tiles/height`, m.data.height) : null;
      const overlay = new BuildingOverlay(ov, bf, view);
      const octx = ov.getContext("2d")!;

      // Simulated traffic (optional layer)
      let weekday = localWeekdayNow();
      const trafficInputs = () => {
        const c = conditionsRef.current;
        const w = weatherEffect(c.rain, c.snow);
        // Google's typical week if it was harvested, else the hand-tuned profile
        const base = profile ? profileAt(profile, c.minutes, weekday) : { demand: typicalDemand(c.minutes, weekday), speed: 1 };
        return { demand: base.demand * w.demand, speedFactor: base.speed * w.speed };
      };
      if (profile) setTrafficSource("google");
      let sim: TrafficSim | null = null;
      let traffic: TrafficRenderer | null = null;
      if (roads) {
        const net = new RoadNetwork(roads);
        sim = new TrafficSim(net);
        traffic = new TrafficRenderer(sim, net, view, heightTiles ? new HeightField(heightTiles) : null);
        trafficRef.current = traffic;
        if (busesFile) busesRef.current = new BusSystem(busesFile, net, sim, busesFile.runningSpeedKmh, busesFile.dwellS);
        // debug hooks for scripted checks (pipeline/.context probes)
        Object.assign(window as unknown as Record<string, unknown>, { __kosmapsTraffic: sim, __kosmapsView: view, __kosmapsBuses: () => busesRef.current, __kosmapsLoader: loader });
        setTrafficAvailable(true);
      }

      const resize = () => {
        view.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
        overlay.resize();
      };
      resize();
      view.home();
      window.addEventListener("resize", resize);
      cleanups.push(() => window.removeEventListener("resize", resize));

      buildingsRef.current = bf;
      setBuildings(bf);
      setMeta(m);
      const hash = location.hash.match(/b=([a-z]+\/\d+)/);
      if (hash) {
        const b = bf.buildings.find((x) => x.osm === hash[1]);
        if (b) select(b.id);
      }
      applyLive(null);
      conditionsRef.current = { ...conditionsRef.current, minutes: localMinutesNow() };
      sim?.seedCars(trafficInputs());
      setLoad({ kind: "ready" });

      const refreshWeather = async () => {
        try {
          const w = await fetchWeather(m.lat, m.lon);
          if (cancelled) return;
          weatherRef.current = w;
          setWeather(w);
          setWeatherFailed(false);
          if (liveRef.current) applyLive(w);
        } catch {
          if (!cancelled) setWeatherFailed(true);
        }
      };
      refreshWeather();
      timers.push(setInterval(refreshWeather, WEATHER_REFRESH_MS));
      timers.push(
        setInterval(() => {
          weekday = localWeekdayNow();
          if (liveRef.current) setConditions((c) => ({ ...c, minutes: localMinutesNow() }));
        }, CLOCK_REFRESH_MS),
      );
      if (sim) {
        timers.push(setInterval(() => {
          setCarCount(sim.cars.length);
          setBusCount(sim.cars.filter((c) => c.kind === "bus").length);
          // refresh the selected bus's card; keep the last state if it has left the map
          const id = selectedBusRef.current, buses = busesRef.current;
          if (id && buses) {
            const info = buses.info(id);
            if (info) setBusInfo({ info, gone: false });
            else {
              setBusInfo((b) => (b ? { ...b, gone: true } : null));
              trafficRef.current?.setSelection(null, null);
            }
          }
        }, 1000));
      }

      let last = performance.now();
      let timeScale = 1;
      const t0 = last;
      const frame = (now: number) => {
        const dt = (now - last) / 1000;
        last = now;
        if (playingRef.current) {
          const c = { ...conditionsRef.current, minutes: (conditionsRef.current.minutes + dt * PLAY_MINUTES_PER_SECOND) % 1440 };
          conditionsRef.current = c;
          setConditions(c);
        }
        const c = conditionsRef.current;
        const { nightK } = lightingFor(sunElevation(dateForMinutes(c.minutes), m.lat, m.lon));
        const uniforms = {
          nightK,
          rain: c.rain, snow: c.snow, smog: smogFromPm(c.pm),
          time: (now - t0) / 1000,
        };
        view.draw(uniforms);
        // CPU data tiles (building ids for clicks, heights for hiding cars) for what's on screen
        const vx = view.off[0], vy = view.off[1], vw = view.width / view.scale, vh = view.height / view.scale;
        idTiles.prefetch(vx, vy, vx + vw, vy + vh);
        heightTiles?.prefetch(vx, vy, vx + vw, vy + vh);
        octx.clearRect(0, 0, ov.width, ov.height);
        if (sim && traffic && trafficOnRef.current) {
          // timelapse: ease the traffic speed up / down when play starts / stops
          timeScale += ((playingRef.current ? TIMELAPSE_SPEED : 1) - timeScale) * Math.min(1, dt * 3);
          const simDt = Math.min(1, dt * timeScale);   // cap: a backgrounded tab returns with a huge dt
          busesRef.current?.update(simDt, conditionsRef.current.minutes, weekday, playingRef.current);
          const inputs = trafficInputs();
          for (let left = simDt; left > 1e-6; left -= SIM_SUBSTEP) sim.step(Math.min(SIM_SUBSTEP, left), inputs);
          traffic.draw(octx, simDt, uniforms);
        }
        overlay.draw(selectedRef.current, hoveredRef.current);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    })().catch((e) => {
      if (!cancelled) setLoad({ kind: "error", message: (e as Error).message });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      timers.forEach(clearInterval);
      cleanups.forEach((f) => f());
      view.dispose();
      renderer.current = null;
      picker.current = null;
    };
  }, [applyLive, select]);

  // ------------------------------------------------------------------ input: pan, zoom, pick
  const pointers = useRef(new Map<number, [number, number]>());
  const pinchDist = useRef<number | null>(null);
  const downAt = useRef<[number, number] | null>(null);

  const pickAt = (x: number, y: number) => {
    const px = renderer.current?.imagePixelAt(x, y);
    return px && picker.current ? picker.current.at(px[0], px[1]) : 0;
  };

  useEffect(() => {
    const canvas = mapCanvas.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      renderer.current?.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { selectBus(0); return select(0); }
      if (e.target instanceof HTMLInputElement) return;
      const v = renderer.current;
      if (!v) return;
      const step = 120 / v.scale;
      if (e.key === "ArrowLeft") v.off[0] -= step;
      if (e.key === "ArrowRight") v.off[0] += step;
      if (e.key === "ArrowUp") v.off[1] -= step;
      if (e.key === "ArrowDown") v.off[1] += step;
      if (e.key === "+" || e.key === "=") v.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.25);
      if (e.key === "-") v.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 0.8);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [select, selectBus]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    downAt.current = [e.clientX, e.clientY];
    e.currentTarget.style.cursor = "grabbing";
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ptrs = pointers.current;
    const prev = ptrs.get(e.pointerId);
    if (!prev) {
      if (ptrs.size) return;
      const bus = trafficOnRef.current ? trafficRef.current?.pickBus(e.clientX, e.clientY) : null;
      hoveredRef.current = bus ? 0 : pickAt(e.clientX, e.clientY);
      e.currentTarget.style.cursor = bus || hoveredRef.current ? "pointer" : "grab";
      return;
    }
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 1) renderer.current?.panBy(e.clientX - prev[0], e.clientY - prev[1]);
    else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinchDist.current) renderer.current?.zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, d / pinchDist.current);
      pinchDist.current = d;
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId);
    pinchDist.current = null;
    if (!pointers.current.size) e.currentTarget.style.cursor = "grab";
    const d = downAt.current;
    if (d && Math.hypot(e.clientX - d[0], e.clientY - d[1]) < CLICK_SLOP_PX) {
      const bus = trafficOnRef.current ? trafficRef.current?.pickBus(e.clientX, e.clientY) : null;
      if (bus) {
        select(0);
        selectBus(bus.id === selectedBusRef.current ? 0 : bus.id);
      } else {
        const id = pickAt(e.clientX, e.clientY);
        selectBus(0);
        select(id === selectedRef.current ? 0 : id);
      }
    }
    downAt.current = null;
  };

  // ------------------------------------------------------------------ UI
  const onSlider = (key: keyof Conditions, value: number) => {
    setConditions((c) => ({ ...c, [key]: value }));
    setLive(false);
    if (key === "minutes") setPlaying(false);
  };

  let status: React.ReactNode = "Loading…";
  if (load.kind === "ready" && meta) {
    const elev = sunElevation(dateForMinutes(conditions.minutes), meta.lat, meta.lon);
    const mode = live && weather
      ? `Live · ${weather.temp.toFixed(0)}°C · ${weather.desc}`
      : live && weatherFailed
        ? "Live weather unavailable — use the sliders."
        : playing ? "Playing a day" : live ? "Live" : "Manual";
    status = (
      <>
        {mode}
        <br />
        {formatMinutes(conditions.minutes)} Prishtinë · sun {elev.toFixed(0)}° · PM2.5 {Math.round(conditions.pm)}
        {trafficAvailable && trafficOn && (
          <>
            <br />
            {carCount - busCount} cars{busCount ? ` · ${busCount} buses` : ""} · simulated{trafficSource === "google" ? " from Google's typical week" : " traffic"}
          </>
        )}
      </>
    );
  }

  const selectedBuilding = selected ? buildings?.buildings[selected - 1] : undefined;

  return (
    <div className={styles.root}>
      <canvas
        ref={mapCanvas}
        className={styles.map}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => { hoveredRef.current = 0; }}
        onDoubleClick={(e) => renderer.current?.zoomAt(e.clientX, e.clientY, 2)}
      />
      <canvas ref={overlayCanvas} className={styles.overlay} />

      {load.kind === "missing" && (
        <div className={styles.message}>
          <div>
            <strong>No map data found.</strong> The illustrated tiles are generated locally and never committed.
            Build them with the pipeline, then export them into <code>public/data/</code>:
            <br />
            <code>cd pipeline &amp;&amp; python export_web.py</code>
          </div>
        </div>
      )}
      {load.kind === "error" && (
        <div className={styles.message}>
          <div>{load.message}</div>
        </div>
      )}

      {selectedBuilding && <BuildingCard building={selectedBuilding} onClose={() => select(0)} />}
      {busInfo && <BusCard info={busInfo.info} gone={busInfo.gone} onClose={() => selectBus(0)} />}

      {panelOpen ? (
        <ControlPanel
          status={status}
          conditions={conditions}
          live={live}
          playing={playing}
          onChange={onSlider}
          onLive={() => {
            setLive(true);
            setPlaying(false);
            applyLive(weatherRef.current);
          }}
          onTogglePlay={() => {
            setPlaying((p) => !p);
            if (!playing) setLive(false);
          }}
          onHome={() => renderer.current?.home()}
          traffic={trafficAvailable ? { on: trafficOn, onToggle: () => setTrafficOn((t) => !t) } : null}
          onHide={() => setPanelOpen(false)}
        />
      ) : (
        <button className={`${styles.button} ${styles.show}`} onClick={() => setPanelOpen(true)}>
          ☰ Controls
        </button>
      )}

      <div className={styles.credit}>
        Base: Google Photorealistic 3D Tiles (Google, Landsat / Copernicus, Airbus) · Weather &amp; air: Open-Meteo · Roads: OpenStreetMap · Traffic simulated ·
        Private prototype
      </div>
      <div className={styles.help}>click a building · drag to pan · scroll / pinch to zoom · double-click to zoom in</div>
    </div>
  );
}
