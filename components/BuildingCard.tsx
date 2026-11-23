import type { Building } from "@/lib/types";
import styles from "./LiveMap.module.css";

export default function BuildingCard({ building: b, onClose }: { building: Building; onClose: () => void }) {
  return (
    <div className={styles.card}>
      <button className={styles.close} title="Close" onClick={onClose}>
        ✕
      </button>
      <div className={styles.kicker}>SELECTED</div>
      <h2>{b.name || b.use}</h2>
      {b.addr && <p>{b.addr}</p>}
      <p>
        {b.start && `Built ${b.start} · `}
        {b.levels ? (
          `${b.levels} stories`
        ) : (
          <>
            ~{b.levels_est} stories <span className={styles.muted}>(estimated)</span>
          </>
        )}
      </p>
      {b.name && <p>{b.use}</p>}
      <p>
        About {Math.round(b.height * 3.28084)} ft tall ({Math.round(b.height)} m)
      </p>
      {b.inside.length > 0 && (
        <>
          <p className={styles.muted} style={{ marginTop: 8 }}>
            Inside
          </p>
          <ul>
            {b.inside.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </>
      )}
      <div className={styles.source}>
        Outline, name, address, use: OpenStreetMap. Height: measured from Google 3D tiles (private prototype
        only).{" "}
        <a href={`https://www.openstreetmap.org/${b.osm}`} target="_blank" rel="noopener noreferrer">
          View on OSM ↗
        </a>
      </div>
    </div>
  );
}
