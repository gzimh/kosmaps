import type { Metadata } from "next";
import LiveMap from "@/components/LiveMap";

export const metadata: Metadata = { title: "Marigona" };

/** Photo-frame mode: the map on its own, always live, no controls. */
export default function Frame() {
  return <LiveMap frame />;
}
