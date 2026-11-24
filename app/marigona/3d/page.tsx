import type { Metadata } from "next";
import World3DMap from "@/components/world3d/World3DMap";

// The data-built 3D scene of Marigona: the pipeline renders its geometry guides and data passes
// (pipeline/world3d/guides.mjs, passes.mjs) from this page.
export const metadata: Metadata = {
  title: "Marigona Residence — 3D data scene",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <World3DMap dataUrl="/data/world3d/marigona" title="Marigona Residence (3D data)" />;
}
