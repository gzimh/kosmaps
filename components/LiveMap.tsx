"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AreaView } from "@/lib/map/areaView";
import { BuildingOverlay, BuildingPicker } from "@/lib/map/buildings";
import { HeightField } from "@/lib/map/heightfield";
import { LandmarkLayer, type Landmark, type LandmarksFile } from "@/lib/map/landmarks";
import { MapRenderer, pickTileFormat } from "@/lib/map/renderer";
import { TiledData, TileLoader } from "@/lib/map/tiles";
import { lightingFor, sunElevation } from "@/lib/sun";
import { dateForMinutes, formatMinutes, localMinutesNow, localWeekdayNow } from "@/lib/time";
import { BusSystem, type BusesFile, type BusInfo } from "@/lib/traffic/buses";
import { profileAt, typicalDemand, weatherEffect, type TrafficProfile } from "@/lib/traffic/demand";
import { RoadNetwork, type RoadsFile } from "@/lib/traffic/network";
import { TrafficRenderer } from "@/lib/traffic/render";
import { TrafficSim } from "@/lib/traffic/sim";
import type { Building, BuildingsFile, Conditions, MapMeta, Weather, WorldMeta } from "@/lib/types";
import { fetchWeather } from "@/lib/weather";
import BuildingCard from "./BuildingCard";
import BusCard from "./BusCard";
import ControlPanel from "./ControlPanel";
import LandmarkCard, { LandmarkBody } from "./LandmarkInfo";
import styles from "./LiveMap.module.css";

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
const getJson = <T,>(url: string): Promise<T | null> => fetch(url).then((r) => (r.ok ? (r.json() as Promise<T>) : null)).catch(() => null);

/** Everything live for one area of the world map (its own mosaic px, buildings, traffic, landmarks). */
interface Area {
  id: string;
  name: string;
  view: AreaView;
  buildings: BuildingsFile;
  picker: BuildingPicker;
  overlay: BuildingOverlay;
  idTiles: TiledData;
  heightTiles: TiledData | null;
  sim: TrafficSim | null;
  traffic: TrafficRenderer | null;
  buses: BusSystem | null;
  landmarks: LandmarkLayer | null;
  profile: TrafficProfile | null;
}

type Sel = { area: string; id: number } | null;

/** The live illustrated world map: every area in one view, with the road between them. */
export default function LiveMap({ dataUrl = "/data", place = "Prishtinë", title }: { dataUrl?: string; place?: string; title?: string } = {}) {
  const mapCanvas = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<MapRenderer | null>(null);
  const areasRef = useRef<Area[]>([]);

  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [meta, setMeta] = useState<WorldMeta | null>(null);
  const [areaNames, setAreaNames] = useState<{ id: string; name: string }[]>([]);
  const [conditions, setConditions] = useState<Conditions>({ minutes: 0, rain: 0, snow: 0, pm: 10 });
  const [live, setLive] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [weather, setWeather] = useState<Weather | null>(null);
  const [weatherFailed, setWeatherFailed] = useState(false);
  const [selected, setSelected] = useState<{ area: string; building: Building; landmark: Landmark | null } | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [trafficAvailable, setTrafficAvailable] = useState(false);
  const [trafficOn, setTrafficOn] = useState(true);
  const [counts, setCounts] = useState({ cars: 0, buses: 0 });
  const [trafficSource, setTrafficSource] = useState<"google" | "typical">("typical");
  const [busInfo, setBusInfo] = useState<{ info: BusInfo; gone: boolean } | null>(null);
  const [landmarkCard, setLandmarkCard] = useState<Landmark | null>(null);

  // Mirrors of state for the animation loop and event handlers (which must not re-subscribe every change).
  const conditionsRef = useRef(conditions);
  const liveRef = useRef(live);
  const playingRef = useRef(playing);
  const weatherRef = useRef(weather);
  const trafficOnRef = useRef(trafficOn);
  const selectedRef = useRef<Sel>(null);
  const hoveredRef = useRef<Sel>(null);
  const selectedBusRef = useRef<Sel>(null);
  const landmarkCardRef = useRef<{ area: string; lm: Landmark } | null>(null);
  const hoverLandmarkRef = useRef<string | null>(null);
  useEffect(() => { trafficOnRef.current = trafficOn; }, [trafficOn]);
  useEffect(() => { conditionsRef.current = conditions; }, [conditions]);
  useEffect(() => { liveRef.current = live; }, [live]);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { weatherRef.current = weather; }, [weather]);

  const areaById = (id: string | undefined) => areasRef.current.find((a) => a.id === id);

  const applyLive = useCallback((w: Weather | null) => {
    setConditions((c) => ({ ...c, minutes: localMinutesNow(), ...(w && { rain: w.rain, snow: w.snow, pm: w.pm }) }));
  }, []);

  /** Select a bus (area + car id), or null to clear. */
  const selectBus = useCallback((sel: Sel) => {
    for (const a of areasRef.current) a.traffic?.setSelection(null, null);
    const a = sel ? areasRef.current.find((x) => x.id === sel.area) : undefined;
    const info = sel && a?.buses ? a.buses.info(sel.id) : null;
    if (info && a?.buses && sel) a.traffic?.setSelection(sel.id, a.buses.routeOf(sel.id));
    selectedBusRef.current = info ? sel : null;
    setBusInfo(info ? { info, gone: false } : null);
  }, []);

  /** Select a building (area + 1-based id), or null to clear. */
  const select = useCallback((sel: Sel) => {
    const a = sel ? areasRef.current.find((x) => x.id === sel.area) : undefined;
    const b = sel && a ? a.buildings.buildings[sel.id - 1] : undefined;
    if (b) {
      selectBus(null);
      landmarkCardRef.current = null;
      setLandmarkCard(null);
    }
    selectedRef.current = b && sel ? sel : null;
    setSelected(b && a ? { area: a.id, building: b, landmark: a.landmarks?.forBuilding(b.id) ?? null } : null);
    history.replaceState(null, "", b ? `#b=${b.osm}` : location.pathname + location.search);
  }, [selectBus]);

  /** Open a landmark: its building's card if it is one, otherwise the landmark card. */
  const selectLandmark = useCallback((area: string | null, lm: Landmark | null) => {
    if (lm?.building && area) return select({ area, id: lm.building });
    selectBus(null);
    select(null);
    landmarkCardRef.current = lm && area ? { area, lm } : null;
    setLandmarkCard(lm);
    history.replaceState(null, "", lm ? `#l=${lm.id}` : location.pathname + location.search);
  }, [select, selectBus]);

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
      const m = await getJson<WorldMeta>(`${dataUrl}/meta.json`);
      if (cancelled) return;
      if (!m?.pyramid?.layers?.day || !m.tiles || !m.areas) return setLoad({ kind: "missing" });
      // imagery streams in as tiles of the world pyramid; each area's data tiles come from its own folder
      const loader = new TileLoader(8);
      view.setPyramid([m.width, m.height], m.pyramid, `${dataUrl}/tiles/${m.tiles}`, loader, await pickTileFormat(m.pyramid.formats), m.home);
      const octx = ov.getContext("2d")!;
      let weekday = localWeekdayNow();
      const phone = Math.min(window.innerWidth, window.innerHeight) < 700;

      const areas: Area[] = [];
      for (const spec of m.areas) {
        const am = await getJson<MapMeta>(`${spec.data}/meta.json`);
        if (!am) continue;
        const L = am.layers, D = spec.data, TILES = `${D}/tiles/${am.tiles}`;
        const [bf, roads, profile, parked, lmFile, busesFile] = await Promise.all([
          getJson<BuildingsFile>(`${D}/${L.buildings}`),
          L.roads ? getJson<RoadsFile>(`${D}/${L.roads}`) : null,
          L.trafficProfile ? getJson<TrafficProfile>(`${D}/${L.trafficProfile}`) : null,
          L.parkedCars ? getJson<{ cars: [number, number, number, number, string | null][] }>(`${D}/${L.parkedCars}`) : null,
          L.landmarks ? getJson<LandmarksFile>(`${D}/${L.landmarks}`) : null,
          L.buses ? getJson<BusesFile & { runningSpeedKmh?: number; dwellS?: number }>(`${D}/${L.buses}`) : null,
        ]);
        if (!bf) continue;
        const av = new AreaView(view, spec.offset[0], spec.offset[1], spec.size);
        const idTiles = new TiledData(loader, `${TILES}/idmap`, am.data.idmap);
        const heightTiles = am.data.height ? new TiledData(loader, `${TILES}/height`, am.data.height) : null;
        const area: Area = {
          id: spec.id, name: spec.name, view: av, buildings: bf, picker: new BuildingPicker(idTiles),
          overlay: new BuildingOverlay(ov, bf, av), idTiles, heightTiles, sim: null, traffic: null, buses: null,
          landmarks: lmFile ? new LandmarkLayer(lmFile, av, am.size, am.mpp) : null, profile,
        };
        if (roads) {
          const net = new RoadNetwork(roads);
          area.sim = new TrafficSim(net);
          // phones: fewer simulated cars (they're tiny on a small screen, and it saves battery)
          if (phone) area.sim.densityScale = 0.65;
          area.traffic = new TrafficRenderer(area.sim, net, av, heightTiles ? new HeightField(heightTiles) : null);
          if (parked) area.traffic.setParkedCars(parked.cars);
          if (busesFile) area.buses = new BusSystem(busesFile, net, area.sim, busesFile.runningSpeedKmh, busesFile.dwellS);
        }
        areas.push(area);
      }
      if (cancelled) return;
      areasRef.current = areas;
      setAreaNames(areas.map((a) => ({ id: a.id, name: a.name })));
      if (areas.some((a) => a.sim)) setTrafficAvailable(true);
      if (areas.some((a) => a.profile)) setTrafficSource("google");
      const first = areas[0];
      // debug hooks for scripted checks (.context probes): the first area's traffic and the world view
      Object.assign(window as unknown as Record<string, unknown>, {
        __kosmapsTraffic: first?.sim, __kosmapsView: view, __kosmapsBuses: () => first?.buses, __kosmapsLoader: loader, __kosmapsAreas: areas,
      });

      const trafficInputs = (a: Area) => {
        const c = conditionsRef.current;
        const w = weatherEffect(c.rain, c.snow);
        // Google's typical week if it was harvested, else the hand-tuned profile
        const base = a.profile ? profileAt(a.profile, c.minutes, weekday) : { demand: typicalDemand(c.minutes, weekday), speed: 1 };
        return { demand: base.demand * w.demand, speedFactor: base.speed * w.speed };
      };

      const resize = () => {
        view.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
        areas[0]?.overlay.resize();
      };
      resize();
      view.home();
      window.addEventListener("resize", resize);
      cleanups.push(() => window.removeEventListener("resize", resize));

      setMeta(m);
      const lmHash = location.hash.match(/l=([a-z_]+)/);
      if (lmHash) {
        for (const a of areas) {
          const lm = a.landmarks?.file.landmarks.find((l) => l.id === lmHash[1]);
          if (lm) { selectLandmark(a.id, lm); break; }
        }
      }
      const hash = location.hash.match(/b=([a-z]+\/\d+)/);
      if (hash) {
        for (const a of areas) {
          const b = a.buildings.buildings.find((x) => x.osm === hash[1]);
          if (b) { select({ area: a.id, id: b.id }); break; }
        }
      }
      applyLive(null);
      conditionsRef.current = { ...conditionsRef.current, minutes: localMinutesNow() };
      for (const a of areas) a.sim?.seedCars(trafficInputs(a));
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
      timers.push(setInterval(() => {
        weekday = localWeekdayNow();
        if (liveRef.current) setConditions((c) => ({ ...c, minutes: localMinutesNow() }));
      }, CLOCK_REFRESH_MS));
      timers.push(setInterval(() => {
        let cars = 0, buses = 0;
        for (const a of areas) for (const c of a.sim?.cars ?? []) { if (c.kind === "bus") buses++; else cars++; }
        setCounts({ cars, buses });
        // refresh the selected bus's card; keep the last state if it has left the map
        const sel = selectedBusRef.current, a = sel ? areas.find((x) => x.id === sel.area) : undefined;
        if (sel && a?.buses) {
          const info = a.buses.info(sel.id);
          if (info) setBusInfo({ info, gone: false });
          else {
            setBusInfo((b) => (b ? { ...b, gone: true } : null));
            a.traffic?.setSelection(null, null);
          }
        }
      }, 1000));

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
        const uniforms = { nightK, rain: c.rain, snow: c.snow, smog: smogFromPm(c.pm), time: (now - t0) / 1000 };
        view.draw(uniforms);
        octx.clearRect(0, 0, ov.width, ov.height);
        // timelapse: ease the traffic speed up / down when play starts / stops
        timeScale += ((playingRef.current ? TIMELAPSE_SPEED : 1) - timeScale) * Math.min(1, dt * 3);
        const simDt = trafficOnRef.current ? Math.min(1, dt * timeScale) : 0;   // cap: a backgrounded tab returns with a huge dt
        for (const a of areas) {
          if (a.sim && simDt > 0) {
            a.buses?.update(simDt, c.minutes, weekday, playingRef.current);
            const inputs = trafficInputs(a);
            for (let left = simDt; left > 1e-6; left -= SIM_SUBSTEP) a.sim.step(Math.min(SIM_SUBSTEP, left), inputs);
          }
          if (!a.view.visible) continue;
          // CPU data tiles (building ids for clicks, heights for hiding cars) for what's on screen
          const [vx, vy] = a.view.off, vw = view.width / view.scale, vh = view.height / view.scale;
          a.idTiles.prefetch(vx, vy, vx + vw, vy + vh);
          a.heightTiles?.prefetch(vx, vy, vx + vw, vy + vh);
          // parked cars are scenery and always drawn; the Traffic button only hides moving vehicles
          a.traffic?.draw(octx, simDt, uniforms, trafficOnRef.current);
          const sel = selectedRef.current, hov = hoveredRef.current;
          a.overlay.draw(sel?.area === a.id ? sel.id : 0, hov?.area === a.id ? hov.id : 0);
          const lmSel = landmarkCardRef.current?.area === a.id ? landmarkCardRef.current.lm.id
            : sel?.area === a.id ? a.landmarks?.forBuilding(sel.id)?.id ?? null : null;
          a.landmarks?.draw(octx, lmSel, hoverLandmarkRef.current, nightK);
        }
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
      areasRef.current = [];
    };
  }, [applyLive, select, selectLandmark, dataUrl]);

  // ------------------------------------------------------------------ input: pan, zoom, pick
  const pointers = useRef(new Map<number, [number, number]>());
  const pinchDist = useRef<number | null>(null);
  const downAt = useRef<[number, number] | null>(null);

  /** Topmost thing under a point: a landmark label, a bus, or a building. */
  const pickAt = (x: number, y: number) => {
    for (const a of areasRef.current) {
      const lm = a.landmarks?.pick(x, y);
      if (lm) return { kind: "landmark" as const, area: a.id, lm };
    }
    if (trafficOnRef.current) {
      for (const a of areasRef.current) {
        const bus = a.traffic?.pickBus(x, y);
        if (bus) return { kind: "bus" as const, area: a.id, id: bus.id };
      }
    }
    for (const a of areasRef.current) {
      const px = a.view.imagePixelAt(x, y);
      const id = px ? a.picker.at(px[0], px[1]) : 0;
      if (id) return { kind: "building" as const, area: a.id, id };
    }
    return null;
  };

  useEffect(() => {
    const canvas = mapCanvas.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      renderer.current?.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { selectBus(null); selectLandmark(null, null); return select(null); }
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
  }, [select, selectBus, selectLandmark]);

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
      const hit = pickAt(e.clientX, e.clientY);
      hoverLandmarkRef.current = hit?.kind === "landmark" ? hit.lm.id : null;
      hoveredRef.current = hit?.kind === "building" ? { area: hit.area, id: hit.id }
        : hit?.kind === "landmark" && hit.lm.building ? { area: hit.area, id: hit.lm.building } : null;
      e.currentTarget.style.cursor = hit ? "pointer" : "grab";
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
    downAt.current = null;
    if (!d || Math.hypot(e.clientX - d[0], e.clientY - d[1]) >= CLICK_SLOP_PX) return;
    const hit = pickAt(e.clientX, e.clientY);
    const sel = selectedRef.current, busSel = selectedBusRef.current;
    if (hit?.kind === "landmark") {
      const already = hit.lm.building ? sel?.area === hit.area && sel.id === hit.lm.building : landmarkCardRef.current?.lm.id === hit.lm.id;
      if (already) { selectLandmark(null, null); select(null); } else selectLandmark(hit.area, hit.lm);
    } else if (hit?.kind === "bus") {
      selectLandmark(null, null);
      select(null);
      selectBus(busSel?.area === hit.area && busSel.id === hit.id ? null : { area: hit.area, id: hit.id });
    } else {
      selectBus(null);
      if (landmarkCardRef.current) { landmarkCardRef.current = null; setLandmarkCard(null); }
      const same = hit?.kind === "building" && sel?.area === hit.area && sel.id === hit.id;
      select(hit?.kind === "building" && !same ? { area: hit.area, id: hit.id } : null);
    }
  };

  // ------------------------------------------------------------------ UI
  const onSlider = (key: keyof Conditions, value: number) => {
    setConditions((c) => ({ ...c, [key]: value }));
    setLive(false);
    if (key === "minutes") setPlaying(false);
  };

  /** Zoom to one area (a comfortable overview of it). */
  const goTo = (id: string) => {
    const a = areaById(id), v = renderer.current;
    if (!a || !v) return;
    const s = a.view.size;
    v.lookAt(a.view.ox + s / 2, a.view.oy + s / 2, (Math.min(v.width, v.height) / s) * 1.1);
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
        {formatMinutes(conditions.minutes)} {place} · sun {elev.toFixed(0)}° · PM2.5 {Math.round(conditions.pm)}
        {trafficAvailable && trafficOn && (
          <>
            <br />
            {counts.cars} cars{counts.buses ? ` · ${counts.buses} buses` : ""} · simulated{trafficSource === "google" ? " from Google's typical week" : " traffic"}
          </>
        )}
      </>
    );
  }

  return (
    <div className={styles.root}>
      <canvas
        ref={mapCanvas}
        className={styles.map}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => { hoveredRef.current = null; }}
        onDoubleClick={(e) => renderer.current?.zoomAt(e.clientX, e.clientY, 2)}
      />
      <canvas ref={overlayCanvas} className={styles.overlay} />

      {load.kind === "missing" && (
        <div className={styles.message}>
          <div>
            <strong>No map data found.</strong> The illustrated tiles are generated locally and never committed.
            Export each area with the pipeline, then build the world map into <code>public/data/</code>:
            <br />
            <code>cd pipeline &amp;&amp; python build_worldmap.py world.json</code>
          </div>
        </div>
      )}
      {load.kind === "error" && (
        <div className={styles.message}>
          <div>{load.message}</div>
        </div>
      )}

      {selected && (
        <BuildingCard building={selected.building} onClose={() => select(null)}>
          {selected.landmark ? <LandmarkBody lm={selected.landmark} /> : null}
        </BuildingCard>
      )}
      {landmarkCard && <LandmarkCard lm={landmarkCard} onClose={() => selectLandmark(null, null)} />}
      {busInfo && <BusCard info={busInfo.info} gone={busInfo.gone} onClose={() => selectBus(null)} />}

      {panelOpen ? (
        <ControlPanel
          title={title}
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
          places={areaNames.length > 1 ? areaNames.map((a) => ({ name: a.name, onGo: () => goTo(a.id) })) : []}
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
