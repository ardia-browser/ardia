import { usePageSpaceId, useWindowId } from "../../state/browser/hooks";
import { noteTabStripPick } from "../../state/telemetry/tabStripCounts";

export function useStripPick() {
  const strip = `${useWindowId()}|${usePageSpaceId()}`;
  return () => noteTabStripPick(strip, performance.now());
}
