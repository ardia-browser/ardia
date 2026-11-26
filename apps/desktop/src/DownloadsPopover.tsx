import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { View } from "react-native";
import { DownloadsPopover as BrowserDownloadsPopover } from "../../browser/src/components/downloads/Downloads";
import { pressOpensDownloadsMenu } from "./downloadsButtonPress";
import { useWindowId } from "../../browser/src/state/browser/hooks";
import { noteLinuxDownloadsPanelInsidePress } from "../../browser/src/state/telemetry/downloadsPanelCounts";
import { setDownloadsOpen } from "../../browser/src/state/windows/actions";
import { useWindowUiOf } from "../../browser/src/state/windows/hooks";
import { startDownloadsDismissal } from "./downloadsDismissal";
import { menuShown } from "./menus";
import { OutsidePressIgnoreContext } from "./outsidePressScope";
import { PageOverlayRegion } from "./PageOverlayRegion";
import { watchPageFocus } from "./pageFocus";
import { nativePopovers } from "./desktopPopovers";
import { createButtonPresses, downloadPresence, downloadsProps, openNativeDownloads } from "./nativeDownloads";
import { hostFiles } from "./hostFiles";
import { DOWNLOADS_BUTTON_TEST_ID } from "../../browser/src/components/downloads/downloadsButtonId";
import { useDownloads } from "../../browser/src/state/browser/hooks";
import { useTheme } from "../../browser/src/components/ui/theme";
import { cancelDownload, keepDownload, pauseDownload, resumeDownload } from "../../browser/src/state/downloads/actions";
import { openDownload } from "../../browser/src/state/downloads/openDownload";
import { revealFile } from "../../browser/src/state/app/system";
import { clearDownloads, dismissDownloadsByPress } from "../../browser/src/state/windows/actions";
import { openInternalPage } from "../../browser/src/state/pages/urls";
import { PLATFORM_TERMS } from "../../browser/src/lib/platformTerms";
import { ardiaHost, reportHostError } from "./host";

export * from "../../browser/src/components/downloads/Downloads";

const DOWNLOADS_BUTTON = `[data-testid="${DOWNLOADS_BUTTON_TEST_ID}"]`;
const FALLBACK_ANCHOR = { x: 10, y: 44, width: 1, height: 1 };

const isDownloadsButton = (target: EventTarget | null) => target instanceof Element && !!target.closest(DOWNLOADS_BUTTON);

function downloadsAnchor() {
  const button = [...document.querySelectorAll(DOWNLOADS_BUTTON)].find((element) => element.getClientRects().length > 0);
  const box = button?.getBoundingClientRect();
  const rect = box && box.width > 0 && box.height > 0 ? { x: box.left, y: box.top, width: box.width, height: box.height } : FALLBACK_ANCHOR;
  return { rect, side: rect.y + rect.height / 2 > window.innerHeight / 2 ? "top" as const : "bottom" as const };
}

function watchButtonPresses() {
  const presses = createButtonPresses(isDownloadsButton, () => performance.now(), (run) => void setTimeout(run, 0));
  const down = (event: PointerEvent) => presses.down(event);
  const up = (event: PointerEvent) => presses.up(event);
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  return {
    press: presses.press,
    afterRelease: presses.afterRelease,
    stop: () => {
      presses.clear();
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    },
  };
}

function NativeDownloadsPopover({ onFallback }: { onFallback: () => void }) {
  const windowId = useWindowId();
  const open = useWindowUiOf(windowId, (ui) => !!ui?.downloadsOpen);
  const list = useDownloads(windowId, useShallow((downloads) => downloads));
  const dark = useTheme().dark;
  const files = ardiaHost ? hostFiles(ardiaHost) : null;
  const [statusVersion, statusChanged] = useState(0);
  useEffect(() => files?.onChange(() => statusChanged((version) => version + 1)), [files]);
  const props = useMemo(() => downloadsProps(list, downloadPresence((path) => files?.fileStatus(path) ?? "unknown"), dark, `Show in ${PLATFORM_TERMS.fileManager}`), [list, dark, statusVersion, open]);
  const latest = useRef({ list, props });
  latest.current = { list, props };
  const controller = useRef<ReturnType<typeof openNativeDownloads> | null>(null);
  useEffect(() => {
    const popovers = nativePopovers();
    if (!open || !popovers) return;
    const presses = watchButtonPresses();
    const opened = openNativeDownloads({
      popovers,
      anchor: downloadsAnchor,
      props: () => latest.current.props,
      list: () => latest.current.list,
      actions: {
        open: (path) => void openDownload(path).catch(reportHostError),
        reveal: (path) => void Promise.resolve(revealFile(path)).catch(reportHostError),
        pause: (id) => void Promise.resolve(pauseDownload(id)).catch(reportHostError),
        resume: (id) => void Promise.resolve(resumeDownload(id)).catch(reportHostError),
        cancel: (id) => void Promise.resolve(cancelDownload(id)).catch(reportHostError),
        keep: (id) => void Promise.resolve(keepDownload(id)).catch(reportHostError),
        clear: () => clearDownloads(windowId),
        viewAll: () => openInternalPage("downloads", windowId),
      },
      close: (byPress) => (byPress ? dismissDownloadsByPress(windowId, { nativeEvent: {} }) : setDownloadsOpen(windowId, false)),
      isButton: isDownloadsButton,
      buttonPress: presses.press,
      afterButtonRelease: presses.afterRelease,
      later: (run, ms) => void setTimeout(run, ms),
      fallback: onFallback,
    });
    controller.current = opened;
    return () => {
      controller.current = null;
      presses.stop();
      opened.stop();
    };
  }, [open, windowId]);
  useEffect(() => controller.current?.update(), [props]);
  return null;
}

export function DownloadsPopover() {
  const [fallback, setFallback] = useState(false);
  return nativePopovers() && !fallback ? <NativeDownloadsPopover onFallback={() => setFallback(true)} /> : <DomDownloadsPopover />;
}

function DomDownloadsPopover() {
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
      opensItsOwnMenu: pressOpensDownloadsMenu,
      watchPageFocus,
      activeElement: () => document.activeElement,
    });
  }, [open, windowId]);
  return (
    <PageOverlayRegion ref={region} testID="ardia-downloads-popover" dataSet={{ open: open ? "true" : "false" }}>
      <OutsidePressIgnoreContext.Provider value={pressOpensDownloadsMenu}>
        <BrowserDownloadsPopover />
      </OutsidePressIgnoreContext.Provider>
    </PageOverlayRegion>
  );
}
