"use client";

import { useEffect, useRef, useState } from "react";
import type { HudState, Picked, World3D } from "@/lib/world3d/engine";
import { formatMinutes } from "@/lib/time";
import styles from "./World3DMap.module.css";

const SOURCE_TEXT: Record<string, string> = {
  photo: "measured from the aerial photo (shadow length + roof lean)",
  known: "from the building's published floor count",
  osm: "from OpenStreetMap",
  typical: "typical for its size (not measurable in the photo)",
};

type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready" };

/** A live 3D miniature of an area, built from data, in the same 45° view as the Dardania map. */
export default function World3DMap({ dataUrl, title }: { dataUrl: string; title: string }) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<World3D | null>(null);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [hud, setHud] = useState<HudState | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);

  useEffect(() => {
    let disposed = false;
    let eng: World3D | null = null;
    import("@/lib/world3d/engine")
      .then(({ World3D }) => World3D.create(host.current!, dataUrl, (p) => setPicked(p)))
      .then((e) => {
        if (disposed) { e.dispose(); return; }
        eng = e;
        engine.current = e;
        if (process.env.NODE_ENV !== "production") {
          // pipeline/world3d scripts (guides, data passes) drive the scene through these
          const w = window as unknown as { __world?: World3D; __THREE?: unknown };
          w.__world = e;
          void import("three").then((T) => { w.__THREE = T; });
        }
        setLoad({ kind: "ready" });
      })
      .catch((err: unknown) => {
        if (!disposed) setLoad({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      disposed = true;
      eng?.dispose();
      engine.current = null;
    };
  }, [dataUrl]);

  useEffect(() => {
    if (load.kind !== "ready") return;
    const id = window.setInterval(() => engine.current && setHud(engine.current.hud()), 200);
    return () => window.clearInterval(id);
  }, [load.kind]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.code === "Escape") { engine.current?.clearSelection(); setPicked(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const b = picked?.building;

  return (
    <div className={styles.root}>
      <div ref={host} className={styles.canvasHost} />

      {load.kind === "loading" && <div className={styles.center}>Building {title} from data…</div>}
      {load.kind === "error" && (
        <div className={styles.center}>
          <div>
            <strong>Couldn&apos;t load the 3D data.</strong>
            <p>{load.message}</p>
            <p className={styles.dim}>
              Generate it with <code>node pipeline/world3d/ortho.mjs</code> and <code>python pipeline/world3d/build_world.py</code> (see README).
            </p>
          </div>
        </div>
      )}

      {hud && (
        <>
          <div className={styles.panel}>
            <div className={styles.title}>{title}</div>
            <div className={styles.timeRow}>
              <span className={styles.clock}>{formatMinutes(hud.minutes)}</span>
              <input
                type="range" min={0} max={1439} step={1} value={Math.floor(hud.minutes) % 1440}
                onChange={(e) => engine.current?.setTime(Number(e.target.value))}
                aria-label="Time of day"
              />
              <button className={hud.live ? styles.on : ""} onClick={() => engine.current?.setTime(null)}>Live</button>
            </div>
            <div className={styles.dim}>
              {hud.cars} cars · {hud.walkers} people · drag to pan, scroll to zoom, click a building
            </div>
          </div>

          {b && (
            <div className={styles.card}>
              <button className={styles.close} onClick={() => { engine.current?.clearSelection(); setPicked(null); }} aria-label="Close">×</button>
              <div className={styles.cardTitle}>{b.name ?? kindName(b.kind)}</div>
              {b.name && <div className={styles.dim}>{kindName(b.kind)}</div>}
              <dl>
                <dt>Height</dt>
                <dd>{b.h.toFixed(1)} m · {b.levels} floor{b.levels === 1 ? "" : "s"}</dd>
                <dt>How we know</dt>
                <dd>{SOURCE_TEXT[b.hSource]}</dd>
                <dt>Roof</dt>
                <dd>{b.roof === "hip" ? "pitched (terracotta in the photo)" : "flat"}</dd>
                <dt>Footprint</dt>
                <dd>{Math.round(area(b.poly))} m²</dd>
              </dl>
              <a href={`https://www.openstreetmap.org/${b.id}`} target="_blank" rel="noreferrer">{b.id} on OpenStreetMap</a>
            </div>
          )}

          <div className={styles.credits}>Imagery &amp; terrain © Google · map data © OpenStreetMap contributors</div>
        </>
      )}
    </div>
  );
}

function kindName(k: string) {
  const s = k === "yes" ? "building" : k.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function area(poly: [number, number][]) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}
