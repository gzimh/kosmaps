"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BuildingOverlay, BuildingPicker } from "@/lib/map/buildings";
import { HeightField } from "@/lib/map/heightfield";
import { LandmarkLayer, type Landmark, type LandmarksFile } from "@/lib/map/landmarks";
import { PerimeterBlur } from "@/lib/map/perimeterBlur";
import { MapRenderer, pickTileFormat } from "@/lib/map/renderer";
import { TiledData, TileLoader } from "@/lib/map/tiles";
import { lightingFor, sunElevation } from "@/lib/sun";
import { dateForMinutes, formatMinutes, localMinutesNow, localWeekdayNow } from "@/lib/time";
import { profileAt, typicalDemand, weatherEffect, type TrafficProfile } from "@/lib/traffic/demand";
import { RoadNetwork, type RoadsFile } from "@/lib/traffic/network";
import { TrafficRenderer } from "@/lib/traffic/render";
import { TrafficSim } from "@/lib/traffic/sim";
import type { Building, BuildingsFile, Conditions, MapMeta, Weather } from "@/lib/types";
import { fetchWeather } from "@/lib/weather";
import BuildingCard from "./BuildingCard";
import CloudIntro, { introOver, introScale } from "./CloudIntro";
import ControlPanel from "./ControlPanel";
import LandmarkCard, { LandmarkBody } from "./LandmarkInfo";
import styles from "./LiveMap.module.css";

const DATA = "/data";
const PLAY_MINUTES_PER_SECOND = 48; // a full day in 30 s
/** Traffic runs this many times faster than real time while playing a day (a timelapse). */
const TIMELAPSE_SPEED = 25;
/** Simulated seconds advanced per substep (keeps car following stable at high speed). */
const SIM_SUBSTEP = 0.1;
const WEATHER_REFRESH_MS = 10 * 60 * 1000;
const CLOCK_REFRESH_MS = 30 * 1000;
const CLICK_SLOP_PX = 5;
/** Photo frame: redraw at most this often (a Raspberry Pi doesn't need 60 fps of a slow world). */
const FRAME_FPS = 30;
/** Photo frame: reload once a day (picks up new versions, clears any slow leak). */
const FRAME_RELOAD_MS = 24 * 60 * 60 * 1000;

type LoadState = { kind: "loading" } | { kind: "missing" } | { kind: "error"; message: string } | { kind: "ready" };

const smogFromPm = (pm: number) => Math.min(1, Math.max(0, (pm - 12) / 160));
const getJson = <T,>(url: string): Promise<T | null> => fetch(url).then((r) => (r.ok ? (r.json() as Promise<T>) : null)).catch(() => null);


interface World {
  buildings: BuildingsFile;
  picker: BuildingPicker;
  landmarks: LandmarkLayer | null;
}

/**
 * Marigona, illustrated, with live sun, weather and traffic, inside a blurred photo of its surroundings.
 * `frame`: photo-frame mode — no controls or interaction, a slow camera drift, always live.
 */
export default function LiveMap({ frame = false }: { frame?: boolean }) {
  const mapCanvas = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const blurLayer = useRef<HTMLDivElement>(null);
  const renderer = useRef<MapRenderer | null>(null);
  const worldRef = useRef<World | null>(null);

  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [meta, setMeta] = useState<MapMeta | null>(null);
  const [conditions, setConditions] = useState<Conditions>({ minutes: 0, rain: 0, snow: 0, pm: 10 });
  const [live, setLive] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [weather, setWeather] = useState<Weather | null>(null);
  const [weatherFailed, setWeatherFailed] = useState(false);
  const [selected, setSelected] = useState<{ building: Building; landmark: Landmark | null } | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [trafficAvailable, setTrafficAvailable] = useState(false);
  const [trafficOn, setTrafficOn] = useState(true);
  const [cars, setCars] = useState(0);
  const [trafficSource, setTrafficSource] = useState<"google" | "typical">("typical");
  const [landmarkCard, setLandmarkCard] = useState<Landmark | null>(null);
  const [dim, setDim] = useState(0);
  // the opening fall through the clouds: when it started (performance.now()), and whether it's over
  const [introStart, setIntroStart] = useState<number | null>(null);
  const [introDone, setIntroDone] = useState(false);
  const introStartRef = useRef<number | null>(null);

  // Mirrors of state for the animation loop and event handlers (which must not re-subscribe every change).
  const conditionsRef = useRef(conditions);
  const liveRef = useRef(live);
  const playingRef = useRef(playing);
  const weatherRef = useRef(weather);
  const trafficOnRef = useRef(trafficOn);
  const selectedRef = useRef(0);
  const hoveredRef = useRef(0);
  const landmarkCardRef = useRef<Landmark | null>(null);
  const hoverLandmarkRef = useRef<string | null>(null);
  useEffect(() => { trafficOnRef.current = trafficOn; }, [trafficOn]);
  useEffect(() => { conditionsRef.current = conditions; }, [conditions]);
  useEffect(() => { liveRef.current = live; }, [live]);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { weatherRef.current = weather; }, [weather]);

  const applyLive = useCallback((w: Weather | null) => {
    setConditions((c) => ({ ...c, minutes: localMinutesNow(), ...(w && { rain: w.rain, snow: w.snow, pm: w.pm }) }));
  }, []);

  /** Select a building (1-based id), or 0 to clear. */
  const select = useCallback((id: number) => {
    const w = worldRef.current;
    const b = id && w ? w.buildings.buildings[id - 1] : undefined;
    if (b) {
      landmarkCardRef.current = null;
      setLandmarkCard(null);
    }
    selectedRef.current = b ? id : 0;
    setSelected(b && w ? { building: b, landmark: w.landmarks?.forBuilding(b.id) ?? null } : null);
    history.replaceState(null, "", b ? `#b=${b.osm}` : location.pathname + location.search);
  }, []);

  /** Open a landmark: its building's card if it is one, otherwise the landmark card. */
  const selectLandmark = useCallback((lm: Landmark | null) => {
    if (lm?.building) return select(lm.building);
    select(0);
    landmarkCardRef.current = lm;
    setLandmarkCard(lm);
    history.replaceState(null, "", lm ? `#l=${lm.id}` : location.pathname + location.search);
  }, [select]);

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
    let blur: PerimeterBlur | null = null;

    (async () => {
      const m = await getJson<MapMeta>(`${DATA}/meta.json`);
      if (cancelled) return;
      if (!m?.pyramid?.layers?.day || !m.tiles) return setLoad({ kind: "missing" });
      const L = m.layers, TILES = `${DATA}/tiles/${m.tiles}`;
      const loader = new TileLoader(8);
      view.setPyramid(m.size, m.pyramid, TILES, loader, await pickTileFormat(m.pyramid.formats));
      const image = (file: string) => fetch(`${DATA}/${file}`).then((r) => r.blob()).then((b) => createImageBitmap(b, { colorSpaceConversion: "none" }));
      // the surroundings under the map (without them the map just ends at its edge)
      const backdrop = m.backdrop;
      const backdropLoaded = backdrop
        ? image(backdrop.file).then((img) => { if (!cancelled) view.setBackdrop(img, backdrop.rect); img.close(); }).catch(() => {})
        : null;
      // the blur layer on top: clear inside the neighbourhood's perimeter, more blurred further out
      // (?perimeter also draws the perimeter line)
      const per = m.perimeter;
      let perimeterLoaded: Promise<void> | null = null;
      if (per && blurLayer.current) {
        const el = blurLayer.current;
        perimeterLoaded = image(per.file).then((img) => {
          if (cancelled) return img.close();
          blur = new PerimeterBlur(el, img, per.rect, m.mpp, new URLSearchParams(location.search).has("perimeter"));
          img.close();
        }).catch(() => {});
      }
      const [bf, roads, profile, parked, lmFile] = await Promise.all([
        getJson<BuildingsFile>(`${DATA}/${L.buildings}`),
        L.roads ? getJson<RoadsFile>(`${DATA}/${L.roads}`) : null,
        L.trafficProfile ? getJson<TrafficProfile>(`${DATA}/${L.trafficProfile}`) : null,
        L.parkedCars ? getJson<{ cars: [number, number, number, number, string | null][] }>(`${DATA}/${L.parkedCars}`) : null,
        L.landmarks ? getJson<LandmarksFile>(`${DATA}/${L.landmarks}`) : null,
      ]);
      if (cancelled) return;
      if (!bf) return setLoad({ kind: "missing" });
      const octx = ov.getContext("2d")!;
      let weekday = localWeekdayNow();
      const phone = Math.min(window.innerWidth, window.innerHeight) < 700;

      const idTiles = new TiledData(loader, `${TILES}/idmap`, m.data.idmap);
      const heightTiles = m.data.height ? new TiledData(loader, `${TILES}/height`, m.data.height) : null;
      const overlay = new BuildingOverlay(ov, bf, view);
      const landmarks = lmFile ? new LandmarkLayer(lmFile, view, m.size, m.mpp) : null;
      worldRef.current = { buildings: bf, picker: new BuildingPicker(idTiles), landmarks };
      let sim: TrafficSim | null = null, traffic: TrafficRenderer | null = null;
      if (roads) {
        const net = new RoadNetwork(roads);
        sim = new TrafficSim(net);
        // phones: fewer simulated cars (they're tiny on a small screen, and it saves battery)
        if (phone) sim.densityScale = 0.65;
        traffic = new TrafficRenderer(sim, net, view, heightTiles ? new HeightField(heightTiles) : null);
        if (parked) traffic.setParkedCars(parked.cars);
        setTrafficAvailable(true);
      }
      if (profile) setTrafficSource("google");
      // debug hooks for scripted checks (.context probes)
      Object.assign(window as unknown as Record<string, unknown>, { __kosmapsTraffic: sim, __kosmapsView: view, __kosmapsLoader: loader });

      const trafficInputs = () => {
        const c = conditionsRef.current;
        const w = weatherEffect(c.rain, c.snow);
        // Google's typical week if it was harvested, else the hand-tuned profile
        const base = profile ? profileAt(profile, c.minutes, weekday) : { demand: typicalDemand(c.minutes, weekday), speed: 1 };
        return { demand: base.demand * w.demand, speedFactor: base.speed * w.speed };
      };

      const resize = () => {
        view.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
        overlay.resize();
        view.home();
      };
      resize();
      window.addEventListener("resize", resize);
      cleanups.push(() => window.removeEventListener("resize", resize));

      setMeta(m);
      if (!frame) {
        const lmHash = location.hash.match(/l=([a-z_]+)/);
        const lm = lmHash && landmarks?.file.landmarks.find((l) => l.id === lmHash[1]);
        if (lm) selectLandmark(lm);
        const hash = location.hash.match(/b=([a-z]+\/\d+)/);
        const b = hash && bf.buildings.find((x) => x.osm === hash[1]);
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
          if (!cancelled) setWeatherFailed(true);   // offline: the sun and traffic still follow the clock
        }
      };
      refreshWeather();
      timers.push(setInterval(refreshWeather, WEATHER_REFRESH_MS));
      timers.push(setInterval(() => {
        weekday = localWeekdayNow();
        if (liveRef.current) setConditions((c) => ({ ...c, minutes: localMinutesNow() }));
      }, CLOCK_REFRESH_MS));
      timers.push(setInterval(() => setCars(sim?.cars.length ?? 0), 1000));

      const introRef = { done: false };
      let last = performance.now();
      let timeScale = 1;
      let lastDim = -1;
      const t0 = last;
      const tick = (now: number) => {
        raf = requestAnimationFrame(tick);
        if (frame && now - last < 1000 / FRAME_FPS - 2) return;
        const dt = (now - last) / 1000;
        last = now;
        const t = (now - t0) / 1000;
        if (playingRef.current) {
          const c = { ...conditionsRef.current, minutes: (conditionsRef.current.minutes + dt * PLAY_MINUTES_PER_SECOND) % 1440 };
          conditionsRef.current = c;
          setConditions(c);
        }
          // the intro: zoom in from further out to the home view while the clouds part
        const intro = !introRef.done;
        if (intro) introRef.done = introOver(introStartRef.current, now);
        if (frame) {
          // a slow drift around the home view: never still, never far
          view.home();
          const S = m.size;
          const s = view.scale * (1.04 + 0.03 * Math.sin(t / 97));
          view.lookAt(S / 2 + S * 0.015 * Math.sin(t / 71), S / 2 + S * 0.012 * Math.sin(t / 53 + 1),
            intro ? introScale(introStartRef.current, now, s, view.minZoom) : s);
        } else if (intro) {
          view.home();
          const home = view.scale;
          view.lookAt(view.off[0] + view.width / home / 2, view.off[1] + view.height / home / 2,
            introScale(introStartRef.current, now, home, view.minZoom));
        }
        const c = conditionsRef.current;
        const elev = sunElevation(dateForMinutes(c.minutes), m.lat, m.lon);
        const { nightK } = lightingFor(elev);
        const uniforms = { nightK, rain: c.rain, snow: c.snow, smog: smogFromPm(c.pm), time: t };
        view.draw(uniforms);
        blur?.update(view);
        // photo frame: dim the screen at night so it doesn't light up the room
        if (frame) {
          const d = Math.round(nightK * 45) / 100;
          if (d !== lastDim) { lastDim = d; setDim(d); }
        }

        octx.clearRect(0, 0, ov.width, ov.height);
        // timelapse: ease the traffic speed up / down when play starts / stops
        timeScale += ((playingRef.current ? TIMELAPSE_SPEED : 1) - timeScale) * Math.min(1, dt * 3);
        const simDt = trafficOnRef.current ? Math.min(1, dt * timeScale) : 0;   // cap: a backgrounded tab returns with a huge dt
        if (sim && simDt > 0) {
          const inputs = trafficInputs();
          for (let left = simDt; left > 1e-6; left -= SIM_SUBSTEP) sim.step(Math.min(SIM_SUBSTEP, left), inputs);
        }
        // CPU data tiles (building ids for clicks, heights for hiding cars) for what's on screen
        const [vx, vy] = view.off, vw = view.width / view.scale, vh = view.height / view.scale;
        if (!frame) idTiles.prefetch(vx, vy, vx + vw, vy + vh);
        heightTiles?.prefetch(vx, vy, vx + vw, vy + vh);
        // parked cars are scenery and always drawn; the Traffic button only hides moving vehicles
        traffic?.draw(octx, simDt, uniforms, trafficOnRef.current);
        overlay.draw(selectedRef.current, hoveredRef.current);
        if (!frame) {
          const sel = selectedRef.current;
          const lmSel = landmarkCardRef.current?.id ?? (sel ? landmarks?.forBuilding(sel)?.id ?? null : null);
          landmarks?.draw(octx, lmSel, hoverLandmarkRef.current, nightK);
        }
      };
      raf = requestAnimationFrame(tick);

      // start the fall through the clouds once the map, its surroundings and the blur are on screen
      // (or after a few seconds, whatever is still loading)
      Promise.race([
        Promise.all([view.ready, backdropLoaded, perimeterLoaded]),
        new Promise((r) => setTimeout(r, 6000)),
      ]).then(() => {
        if (cancelled) return;
        introStartRef.current = performance.now();
        setIntroStart(introStartRef.current);
        (window as unknown as Record<string, unknown>).__kosmapsIntroStart = introStartRef.current;
      });

      if (frame) {
        // keep the screen on; the browser drops the lock when the tab is hidden, so take it again
        let lock: WakeLockSentinel | null = null;
        const wake = async () => {
          try { if (document.visibilityState === "visible") lock = await navigator.wakeLock?.request("screen"); } catch { /* not supported */ }
        };
        wake();
        document.addEventListener("visibilitychange", wake);
        const reload = setTimeout(() => location.reload(), FRAME_RELOAD_MS);
        cleanups.push(() => {
          document.removeEventListener("visibilitychange", wake);
          clearTimeout(reload);
          lock?.release().catch(() => {});
        });
      }
    })().catch((e) => {
      if (!cancelled) setLoad({ kind: "error", message: (e as Error).message });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      timers.forEach(clearInterval);
      cleanups.forEach((f) => f());
      view.dispose();
      blur?.dispose();
      renderer.current = null;
      worldRef.current = null;
    };
  }, [applyLive, select, selectLandmark, frame]);

  // ------------------------------------------------------------------ input: pan, zoom, pick
  const pointers = useRef(new Map<number, [number, number]>());
  const pinchDist = useRef<number | null>(null);
  const downAt = useRef<[number, number] | null>(null);

  /** Topmost thing under a point: a landmark label or a building. */
  const pickAt = (x: number, y: number) => {
    const w = worldRef.current;
    if (!w) return null;
    const lm = w.landmarks?.pick(x, y);
    if (lm) return { kind: "landmark" as const, lm };
    const px = renderer.current?.imagePixelAt(x, y);
    const id = px ? w.picker.at(px[0], px[1]) : 0;
    return id ? { kind: "building" as const, id } : null;
  };

  useEffect(() => {
    if (frame) return;
    const canvas = mapCanvas.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      renderer.current?.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { selectLandmark(null); return select(0); }
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
  }, [select, selectLandmark, frame]);

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
      hoveredRef.current = hit?.kind === "building" ? hit.id : hit?.kind === "landmark" ? hit.lm.building ?? 0 : 0;
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
    const sel = selectedRef.current;
    if (hit?.kind === "landmark") {
      const already = hit.lm.building ? sel === hit.lm.building : landmarkCardRef.current?.id === hit.lm.id;
      if (already) { selectLandmark(null); select(0); } else selectLandmark(hit.lm);
    } else {
      if (landmarkCardRef.current) { landmarkCardRef.current = null; setLandmarkCard(null); }
      select(hit?.kind === "building" && sel !== hit.id ? hit.id : 0);
    }
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
        {formatMinutes(conditions.minutes)} · sun {elev.toFixed(0)}° · PM2.5 {Math.round(conditions.pm)}
        {trafficAvailable && trafficOn && (
          <>
            <br />
            {cars} cars · simulated{trafficSource === "google" ? " from Google's typical week" : " traffic"}
          </>
        )}
      </>
    );
  }

  return (
    <div className={`${styles.root} ${frame ? styles.frame : ""}`}>
      <canvas
        ref={mapCanvas}
        className={styles.map}
        {...(!frame && {
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
          onPointerLeave: () => { hoveredRef.current = 0; },
          onDoubleClick: (e: React.MouseEvent) => renderer.current?.zoomAt(e.clientX, e.clientY, 2),
        })}
      />
      <canvas ref={overlayCanvas} className={styles.overlay} />
      <div ref={blurLayer} className={styles.blur} />
      {frame && dim > 0 && <div className={styles.dim} style={{ opacity: dim }} />}

      {load.kind === "missing" && (
        <div className={styles.message}>
          <div>
            <strong>No map data found.</strong> The illustrated tiles are generated locally and never committed.
            Export them into <code>public/data/</code> with <code>cd pipeline &amp;&amp; python export_web.py</code>.
          </div>
        </div>
      )}
      {load.kind === "error" && (
        <div className={styles.message}>
          <div>{load.message}</div>
        </div>
      )}

      {!frame && (
        <>
          {selected && (
            <BuildingCard building={selected.building} onClose={() => select(0)}>
              {selected.landmark ? <LandmarkBody lm={selected.landmark} /> : null}
            </BuildingCard>
          )}
          {landmarkCard && <LandmarkCard lm={landmarkCard} onClose={() => selectLandmark(null)} />}

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
          <div className={styles.help}>click a building · drag to pan · scroll / pinch to zoom · double-click to zoom in</div>
        </>
      )}

      {!introDone && (
        <CloudIntro
          start={load.kind === "missing" || load.kind === "error" ? (introStart ?? 0) : introStart}
          onDone={() => setIntroDone(true)}
        />
      )}

      <div className={styles.credit}>
        {frame
          ? "Google · OpenStreetMap · Open-Meteo"
          : "Base: Google Photorealistic 3D Tiles (Google, Landsat / Copernicus, Airbus) · Weather & air: Open-Meteo · Roads: OpenStreetMap · Traffic simulated · Private prototype"}
      </div>
    </div>
  );
}
