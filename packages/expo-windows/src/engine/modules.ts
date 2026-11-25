import { engineDomainModules } from "./domains";
import { setCover, setPageRadius } from "./covers";
import { discardOffered } from "./host";
import { followPage, parkPage, releasePage } from "./pages";
import { takeKeptFollows } from "./keptFollow";

const pageCovers = {
  set: (windowId: string, id: string, x: number, y: number, width: number, height: number, radius = 0) => setCover(windowId, id, { x, y, width, height, radius }),
  clear: (windowId: string, id: string) => setCover(windowId, id, null),
  setRadius: (radius: number, windowId?: string) => setPageRadius(radius, windowId ?? ""),
};

export const engineModules: Record<string, Record<string, unknown>> = {
  ArdiaPageCovers: pageCovers,
  ...engineDomainModules,
  ArdiaTabs: {
    ...engineDomainModules.ArdiaTabs,
    prepareTransfer: (tabId: string) => parkPage(tabId),
    releaseTransfer: (tabId: string) => releasePage(tabId),
    claimLaunchTab: () => {},
    revealTab: () => {},
    dropTabReveals: () => {},
    claimTabPress: () => 0,
    dropTabPress: () => {},
    setTabsInSplits: () => {},
    setNativeTabSwitch: () => {},
    revealOffered: () => {},
    discardOffered: (adoptId: string) => discardOffered(adoptId),
    followKeyboard: (tabId: string, windowId?: string) => followPage(tabId, windowId),
    takeKeptFollows: () => takeKeptFollows(),
  },
};
