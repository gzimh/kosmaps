import type { Conditions } from "@/lib/types";
import { formatMinutes } from "@/lib/time";
import styles from "./LiveMap.module.css";

type SliderKey = "minutes" | "rain" | "snow" | "pm";

const SLIDERS: { key: SliderKey; label: string; max: number; scale: number; fmt: (v: number) => string }[] = [
  { key: "minutes", label: "Time", max: 1439, scale: 1, fmt: formatMinutes },
  { key: "rain", label: "Rain", max: 100, scale: 100, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: "snow", label: "Snow", max: 100, scale: 100, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: "pm", label: "PM2.5", max: 250, scale: 1, fmt: (v) => String(Math.round(v)) },
];

interface Props {
  status: React.ReactNode;
  conditions: Conditions;
  live: boolean;
  playing: boolean;
  onChange: (key: SliderKey, value: number) => void;
  onLive: () => void;
  onTogglePlay: () => void;
  onHome: () => void;
  onHide: () => void;
  /** null when the map has no road data (traffic layer unavailable). */
  traffic: { on: boolean; onToggle: () => void } | null;
  title?: string;
}

export default function ControlPanel({ status, conditions, live, playing, onChange, onLive, onTogglePlay, onHome, onHide, traffic, title = "Marigona" }: Props) {
  return (
    <div className={styles.panel}>
      <button className={styles.close} title="Hide" onClick={onHide}>
        ✕
      </button>
      <h1>{title}</h1>
      <div className={styles.status}>{status}</div>
      {SLIDERS.map(({ key, label, max, scale, fmt }) => {
        const value = key === "minutes" ? Math.round(conditions.minutes) % 1440 : conditions[key];
        return (
          <div className={styles.row} key={key}>
            <label htmlFor={`s-${key}`}>{label}</label>
            <input
              id={`s-${key}`}
              type="range"
              min={0}
              max={max}
              step={1}
              value={Math.round(value * scale)}
              onChange={(e) => onChange(key, Number(e.target.value) / scale)}
            />
            <span>{fmt(value)}</span>
          </div>
        );
      })}
      <div className={styles.buttons}>
        <button className={`${styles.button} ${live ? styles.on : ""}`} onClick={onLive}>
          ● Live
        </button>
        <button className={`${styles.button} ${playing ? styles.on : ""}`} onClick={onTogglePlay}>
          {playing ? "❚❚ Pause" : "▶ Play a day"}
        </button>
        <button className={styles.button} onClick={onHome}>
          Reset view
        </button>
        {traffic && (
          <button className={`${styles.button} ${traffic.on ? styles.on : ""}`} onClick={traffic.onToggle} title="Simulated traffic">
            Traffic
          </button>
        )}
      </div>
    </div>
  );
}
