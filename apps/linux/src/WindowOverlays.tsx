import type { ComponentProps } from "react";
import { WindowOverlays as BrowserWindowOverlays } from "../../browser/src/components/window/WindowOverlays";
import { PageOverlayRegion } from "./PageOverlayRegion";

export function WindowOverlays(props: ComponentProps<typeof BrowserWindowOverlays>) {
  return (
    <PageOverlayRegion testID="ardia-window-overlays">
      <BrowserWindowOverlays {...props} />
    </PageOverlayRegion>
  );
}
