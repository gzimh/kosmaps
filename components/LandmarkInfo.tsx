import type { Landmark } from "@/lib/map/landmarks";
import styles from "./LiveMap.module.css";

const LANG: Record<string, string> = { en: "Wikipedia · English", sq: "Wikipedia · Shqip", wikidata: "Wikidata" };

/** What a landmark is, and where to read more (Wikipedia first). */
export function LandmarkBody({ lm }: { lm: Landmark }) {
  const links = [...lm.links].sort((a, b) => (a.lang === "en" ? 0 : a.lang === "sq" ? 1 : 2) - (b.lang === "en" ? 0 : b.lang === "sq" ? 1 : 2));
  return (
    <div className={styles.landmark}>
      <p>{lm.summary}</p>
      <p className={styles.muted} style={{ marginTop: 8 }}>
        Read more
      </p>
      <ul className={styles.linkList}>
        {links.map((l) => (
          <li key={l.url}>
            <a href={l.url} target="_blank" rel="noopener noreferrer">
              {l.title} ↗
            </a>
            <span className={styles.linkSource}>{LANG[l.lang] ?? l.lang}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Card for landmarks that aren't a clickable building (boulevards, neighbourhoods, monuments). */
export default function LandmarkCard({ lm, onClose }: { lm: Landmark; onClose: () => void }) {
  return (
    <div className={styles.card}>
      <button className={styles.close} title="Close" onClick={onClose}>
        ✕
      </button>
      <div className={styles.kicker}>LANDMARK · {lm.kind.toUpperCase()}</div>
      <h2>{lm.name}</h2>
      {lm.local && lm.local !== lm.name && <p className={styles.muted}>{lm.local}</p>}
      <LandmarkBody lm={lm} />
      <div className={styles.source}>Summary written for this map from the linked articles.</div>
    </div>
  );
}
