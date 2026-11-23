import type { ComponentProps } from "react";
import { SplitMoveHandles as BrowserSplitMoveHandles } from "../../browser/src/components/split/SplitMoveHandles";
import { PageOverlayRegion } from "./PageOverlayRegion";

export * from "../../browser/src/components/split/SplitMoveHandles";

export function SplitMoveHandles(props: ComponentProps<typeof BrowserSplitMoveHandles>) {
  return (
    <PageOverlayRegion testID="ardia-split-move-handles">
      <BrowserSplitMoveHandles {...props} />
    </PageOverlayRegion>
  );
}
