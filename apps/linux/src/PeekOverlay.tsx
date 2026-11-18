import type { ComponentProps } from "react";
import { PeekOverlay as BrowserPeekOverlay } from "../../browser/src/components/peek/PeekOverlay";
import { useBrowser } from "../../browser/src/state/browser/store";
import { shownPeek } from "../../browser/src/state/peek/peek";
import { PageOverlayRegion } from "./PageOverlayRegion";

export * from "../../browser/src/components/peek/PeekOverlay";

const PEEK_STACK = { ardiaPageStack: "peek" };

export function PeekOverlay(props: ComponentProps<typeof BrowserPeekOverlay>) {
  const shown = useBrowser((s) => !!shownPeek(s, props.windowId));
  return (
    <PageOverlayRegion testID="ardia-peek" dataSet={PEEK_STACK} capturing={shown}>
      <BrowserPeekOverlay {...props} />
    </PageOverlayRegion>
  );
}
