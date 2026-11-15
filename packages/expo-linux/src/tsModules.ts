import { withLinuxShortcuts } from "./chromium/keys/menuShortcuts";
import { cancelEngineRecording, isEngineRecording, startEngineRecording, stopEngineRecording } from "./chromium/recording";
import { linuxFocus } from "./focus";
import { linuxInlineCompletion } from "./inlineCompletion";
import { devPagerState, pagerState, selectPager, stepPager, switchPager } from "./web/Pager";
import { watchSidebarEdge } from "./web/motion/sidebarEdge";
import { animateWindowClose, closeWindow, focusWindow, openWindow, setWindowTitle } from "./windows/appWindows";
import { dragPreviewModule } from "./windows/dragPreview";

type Call = (...values: unknown[]) => unknown;

export const writtenInTs: Record<string, Record<string, unknown>> = {
  ArdiaAppWindows: {
    openWindow,
    animateWindowClose,
    watchSidebarEdge: async (id: string, on: boolean, hold: number, right: boolean) => watchSidebarEdge(id, on, hold, right),
    ...dragPreviewModule,
    raiseView: async () => {},
  },
  ArdiaFocus: linuxFocus,
  ArdiaInlineCompletion: linuxInlineCompletion,
  ArdiaSwipe: { haptic: () => {}, switchPager, stepPager, selectPager, pagerState, devPagerState, devSimulate: async () => null },
};

export const aroundMain: Record<string, Record<string, (main: Call | null) => unknown>> = {
  ArdiaAppWindows: {
    closeWindow: (main) => (id: string) => closeWindow(id, main),
    focusWindow: () => (id: string) => focusWindow(id),
    setWindowTitle: (main) => (id: string, title: string) => setWindowTitle(id, title, main),
  },
  ArdiaFocus: {
    claimFocus: () => linuxFocus.claimFocus,
    saveKeyResponder: () => linuxFocus.saveKeyResponder,
    restoreKeyResponder: () => linuxFocus.restoreKeyResponder,
    discardKeyResponder: () => linuxFocus.discardKeyResponder,
  },
  ArdiaMenus: {
    showMenu: (main) => (items: unknown) => (main ? main(withLinuxShortcuts(items)) : Promise.resolve(null)),
  },
  ArdiaReport: {
    startRecording: () => startEngineRecording,
    stopRecording: () => stopEngineRecording,
    cancelRecording: () => cancelEngineRecording,
    isRecording: () => isEngineRecording,
  },
};
