import { useEffect, useRef } from "react";
import type { BusInfo } from "@/lib/traffic/buses";
import { formatMinutes } from "@/lib/time";
import styles from "./LiveMap.module.css";

function status(late: number) {
  const m = Math.round(Math.abs(late));
  if (m < 1) return { text: "On time", tone: styles.onTime };
  return late > 0 ? { text: `${m} min late`, tone: styles.late } : { text: `${m} min early`, tone: styles.early };
}

export default function BusCard({ info, gone, onClose }: { info: BusInfo; gone: boolean; onClose: () => void }) {
  const { line, variant, times, nextStop } = info;
  const dir = line.directions?.[String(variant.id)];
  const to = dir?.to ?? variant.to ?? "";
  const st = status(info.lateMin);
  const listRef = useRef<HTMLOListElement>(null);

  // keep the next stop in view as the bus moves along
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>("[data-next]");
    el?.scrollIntoView({ block: "center" });
  }, [nextStop]);

  return (
    <div className={`${styles.card} ${styles.busCard}`}>
      <button className={styles.close} title="Close" onClick={onClose}>
        ✕
      </button>
      <div className={styles.kicker}>BUS · TRAFIKU URBAN</div>
      <div className={styles.busHead}>
        <span className={styles.lineBadge} style={{ background: line.color }}>
          {line.ref}
        </span>
        <div>
          <h2>Line {line.ref}</h2>
          <p className={styles.muted}>{line.name}</p>
        </div>
      </div>
      <p>
        <strong>→ {to}</strong>
      </p>
      {gone ? (
        <p className={styles.muted}>This bus has left the map area.</p>
      ) : (
        <p>
          <span className={`${styles.pill} ${st.tone}`}>{st.text}</span>{" "}
          {info.dwelling ? (info.lateMin < -0.5 ? "Waiting at " : "At ") : "Next stop "}
          <strong>{variant.stops[nextStop]?.name}</strong>
          {!info.dwelling && <> · {formatMinutes(times[nextStop])}</>}
        </p>
      )}
      <ol className={styles.stopList} ref={listRef}>
        {variant.stops.map((s, i) => (
          <li
            key={`${s.name}-${i}`}
            className={i < nextStop ? styles.stopPast : i === nextStop ? styles.stopNext : undefined}
            {...(i === nextStop ? { "data-next": "" } : {})}
          >
            <span className={styles.stopTime}>{formatMinutes(times[i])}</span>
            <span className={styles.stopDot} style={i === nextStop ? { background: line.color, borderColor: line.color } : { borderColor: line.color }} />
            <span>{s.name}</span>
          </li>
        ))}
      </ol>
      <p className={styles.muted} style={{ marginTop: 8 }}>
        Left the terminus at {formatMinutes(info.departure)}
        {info.headwayNow ? ` · a bus every ~${info.headwayNow} min now` : ""}
        {info.firstLast ? ` · first ${formatMinutes(info.firstLast[0])}, last ${formatMinutes(info.firstLast[1])}` : ""}
      </p>
      <div className={styles.source}>
        {line.source === "official" ? (
          <>
            Departures: official Trafiku Urban timetable
            {line.url && (
              <>
                {" "}
                <a href={line.url} target="_blank" rel="noopener noreferrer">
                  ↗
                </a>
              </>
            )}
            .{" "}
          </>
        ) : (
          <>{line.note}. </>
        )}
        Times at stops are estimated (timetables only list terminus departures); the bus is simulated. Route and
        stops: OpenStreetMap.
      </div>
    </div>
  );
}
