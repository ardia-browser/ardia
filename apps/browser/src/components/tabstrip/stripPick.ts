import { usePageProfileId, useWindowId } from "../../state/browser/hooks";
import { noteTabStripPick } from "../../state/telemetry/tabStripCounts";

export function useStripPick() {
  const strip = `${useWindowId()}|${usePageProfileId()}`;
  return () => noteTabStripPick(strip, performance.now());
}
