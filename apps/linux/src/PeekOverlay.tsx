import type { ComponentProps } from "react";
import { PeekOverlay as BrowserPeekOverlay } from "../../browser/src/components/peek/PeekOverlay";
import { usePeeks } from "../../browser/src/state/peek/hooks";
import { PageOverlayRegion } from "./PageOverlayRegion";

export * from "../../browser/src/components/peek/PeekOverlay";

const PEEK_STACK = { ardiaPageStack: "peek" };

export function PeekOverlay(props: ComponentProps<typeof BrowserPeekOverlay>) {
  const open = usePeeks((peeks) => !!peeks[props.windowId]);
  if (!open) return <BrowserPeekOverlay {...props} />;
  return (
    <PageOverlayRegion testID="ardia-peek" dataSet={PEEK_STACK}>
      <BrowserPeekOverlay {...props} />
    </PageOverlayRegion>
  );
}
