import { useEffect, useRef } from "react";
import type { View } from "react-native";
import { DownloadsPopover as BrowserDownloadsPopover } from "../../browser/src/components/downloads/Downloads";
import { useWindowId } from "../../browser/src/state/browser/hooks";
import { noteLinuxDownloadsPanelInsidePress } from "../../browser/src/state/telemetry/downloadsPanelCounts";
import { setDownloadsOpen } from "../../browser/src/state/windows/actions";
import { useWindowUiOf } from "../../browser/src/state/windows/hooks";
import { startDownloadsDismissal } from "./downloadsDismissal";
import { menuShown } from "./menus";
import { PageOverlayRegion } from "./PageOverlayRegion";
import { watchPageFocus } from "./pageFocus";

export * from "../../browser/src/components/downloads/Downloads";

export function DownloadsPopover() {
  const windowId = useWindowId();
  const open = useWindowUiOf(windowId, (ui) => !!ui?.downloadsOpen);
  const region = useRef<(View & HTMLElement) | null>(null);
  useEffect(() => {
    if (!open) return;
    return startDownloadsDismissal({
      target: window,
      inside: (node) => node instanceof Node && !!region.current?.contains(node),
      onInsidePress: noteLinuxDownloadsPanelInsidePress,
      close: () => setDownloadsOpen(windowId, false),
      menuShown,
      watchPageFocus,
      activeElement: () => document.activeElement,
    });
  }, [open, windowId]);
  return (
    <PageOverlayRegion ref={region} testID="ardia-downloads-popover" dataSet={{ open: open ? "true" : "false" }}>
      <BrowserDownloadsPopover />
    </PageOverlayRegion>
  );
}
