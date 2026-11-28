import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { HostPill } from "../components/browsing/HostPill";
import { MaterialBarPill } from "../components/browsing/PersistentMaterialBar";
import { downloadIndicatorLayout } from "../components/browsing/downloadIndicatorTokens";
import { ChromeSurface, DesignProvider } from "../components/ui";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { useBrowse } from "../state/browse/store";
import { forgetRunningDownloads, noteDownloadEnded, noteDownloadsReported, noteDownloadStarted, useRunningDownloads } from "../state/downloads/running";
import { DOWNLOAD_INDICATOR_DELAY_MS } from "../state/downloads/runningRules";
import { useLibrary } from "../state/library/store";
import * as library from "../state/library/store";
import { forgetDownloadCards } from "../state/page/downloadCards";
import { usePageUi } from "../state/page/store";
import { storeNavigation, usePages, type PageState } from "../state/pages/store";
import { currentTabs, useTabs } from "../state/tabs/store";
import { downloads } from "../platform/downloads";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const telemetry = require("../state/telemetry/telemetry") as typeof import("../state/telemetry/telemetry");

type Root = ReturnType<typeof renderSurface>;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  usePages.setState({ tones: {}, lastTones: {}, heldTones: {} });
  usePageUi.setState({ findOpen: false });
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  useLibrary.setState({ open: false, section: "history", alone: false, path: [] });
  forgetRunningDownloads();
  forgetDownloadCards();
  jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined).mockClear();
  jest.spyOn(library, "loadDownloads").mockImplementation(async () => undefined);
  jest.spyOn(downloads, "active").mockImplementation(async () => []);
});

afterEach(() => {
  act(() => forgetRunningDownloads());
  act(() => useTabs.setState({ incognito: false }));
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const pageOf = (design: "redesigned" | "material") => {
  const tab = currentTabs().open[0]!;
  act(() => storeNavigation(tab.id, { url: "https://site0.example/", title: "Site", isLive: true, isLoading: false, progress: 1, failure: null, canGoBack: false, canGoForward: false, scrollDirection: "up" } as unknown as PageState));
  return renderSurface(
    <DesignProvider design={design}>
      <BrowsingScreen tabId={tab.id} />
    </DesignProvider>,
  );
};

const hosts = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");
const pressOf = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.props.onPress === "function")[0]!;
const arcOf = (root: Root) => root.root.findAll((node: ReactTestInstance) => node.props.testID === "downloadRingArc")[0]!.props as { strokeDasharray: string; strokeDashoffset: number };
const shareOf = (root: Root) => {
  const arc = arcOf(root);
  const around = Number(arc.strokeDasharray.split(" ")[0]);
  return 1 - arc.strokeDashoffset / around;
};
const wait = (ms: number) => act(() => jest.advanceTimersByTime(ms));
const counts = () => (telemetry.countUsage as unknown as jest.Mock).mock.calls.map(([field]) => field as string);
const report = (rows: { id: string; bytes: number; total: number | null }[]) => act(() => noteDownloadsReported(rows.map((row) => ({ ...row, fileName: `${row.id}.pdf`, fraction: row.total ? row.bytes / row.total : null, isQueued: false }))));

test("the floating bar's ring shows only after a download has run 800 ms, beside the page menu, and goes when it ends", () => {
  const root = pageOf("redesigned");
  act(() => noteDownloadStarted("1", "otter.pdf", false, 1000));
  expect(hosts(root, "floatingBarDownloads")).toHaveLength(0);
  wait(DOWNLOAD_INDICATOR_DELAY_MS - 1);
  expect(hosts(root, "floatingBarDownloads")).toHaveLength(0);
  wait(1);
  expect(hosts(root, "floatingBarDownloads")).toHaveLength(1);
  report([{ id: "1", bytes: 450, total: 1000 }]);
  expect(shareOf(root)).toBeCloseTo(0.45, 5);
  expect(hosts(root, "floatingBarDownloads")[0]!.props).toMatchObject({ accessibilityRole: "button", accessibilityLabel: "Downloads, 1 in progress, 40%", accessibilityLiveRegion: "polite" });
  act(() => noteDownloadEnded("1"));
  expect(hosts(root, "floatingBarDownloads")).toHaveLength(0);
  unmount(root);
});

test("a fast download never shows the ring", () => {
  const root = pageOf("redesigned");
  act(() => noteDownloadStarted("1", "otter.pdf", false, 1000));
  wait(300);
  act(() => noteDownloadEnded("1"));
  wait(DOWNLOAD_INDICATOR_DELAY_MS);
  expect(hosts(root, "floatingBarDownloads")).toHaveLength(0);
  unmount(root);
});

test("several downloads fill one ring with their combined bytes, and it spins when any size is unknown", () => {
  const root = pageOf("redesigned");
  act(() => noteDownloadStarted("1", "a.pdf", false, 100));
  act(() => noteDownloadStarted("2", "b.pdf", false, 300));
  wait(DOWNLOAD_INDICATOR_DELAY_MS);
  report([
    { id: "1", bytes: 50, total: 100 },
    { id: "2", bytes: 150, total: 300 },
  ]);
  expect(shareOf(root)).toBeCloseTo(0.5, 5);
  expect(hosts(root, "floatingBarDownloads")[0]!.props.accessibilityLabel).toBe("Downloads, 2 in progress, 50%");
  act(() => noteDownloadStarted("3", "c.bin", false, null));
  report([
    { id: "1", bytes: 50, total: 100 },
    { id: "2", bytes: 150, total: 300 },
    { id: "3", bytes: 10, total: null },
  ]);
  expect(shareOf(root)).toBeCloseTo(downloadIndicatorLayout.indeterminateShare, 5);
  expect(hosts(root, "floatingBarDownloads")[0]!.props.accessibilityLabel).toBe("Downloads, 3 in progress");
  unmount(root);
});

test("tapping the ring opens Downloads alone, without the History and Bookmarks switcher, and counts it outside Incognito", () => {
  const root = pageOf("redesigned");
  act(() => noteDownloadStarted("1", "otter.pdf", false, 1000));
  wait(DOWNLOAD_INDICATOR_DELAY_MS);
  act(() => pressOf(root, "floatingBarDownloads").props.onPress());
  expect(useLibrary.getState()).toMatchObject({ open: true, section: "downloads", alone: true });
  expect(counts()).toContain("download_indicator_opened");
  unmount(root);
});

test("a private download shows the ring too, but opening Downloads from it counts nothing", () => {
  const root = pageOf("redesigned");
  act(() => noteDownloadStarted("1", "otter.pdf", true, 1000));
  wait(DOWNLOAD_INDICATOR_DELAY_MS);
  expect(hosts(root, "floatingBarDownloads")).toHaveLength(1);
  act(() => pressOf(root, "floatingBarDownloads").props.onPress());
  expect(useLibrary.getState().alone).toBe(true);
  expect(counts()).not.toContain("download_indicator_opened");
  unmount(root);
});

test("the ring takes the plate's own ink in the floating bar and on the collapsed host pill", () => {
  act(() => noteDownloadStarted("1", "otter.pdf", false, 1000));
  wait(DOWNLOAD_INDICATOR_DELAY_MS);
  const tab = currentTabs().open[0]!;
  const pill = renderSurface(<HostPill tab={tab} dark shown contentStyle={null} onExpand={() => undefined} />);
  expect(hosts(pill, "hostPillDownloads")).toHaveLength(1);
  const stroke = pill.root.findAll((node) => node.props.testID === "downloadRingArc")[0]!.props.stroke as string;
  expect(stroke).toBe(require("../components/ui").surfaceInkFor(true).chrome.foreground);
  expect(pill.root.findAll((node) => node.type === ChromeSurface)).toHaveLength(1);
  unmount(pill);
});

const onAndroid = Platform.OS === "android" ? test : test.skip;

onAndroid("Material You's address field and its collapsed pill carry the ring in the scheme's variant ink", () => {
  act(() => noteDownloadStarted("1", "otter.pdf", false, 1000));
  wait(DOWNLOAD_INDICATOR_DELAY_MS);
  const root = pageOf("material");
  expect(root.root.findAll((node) => node.props.testID === "materialBarDownloads").length).toBeGreaterThan(0);
  unmount(root);
  const scheme = SEEDED_SCHEMES.ardia.light;
  const pill = renderSurface(
    <DesignProvider design="material">
      <MaterialBarPill tab={currentTabs().open[0]!} scheme={scheme} onExpand={() => undefined} />
    </DesignProvider>,
  );
  expect(hosts(pill, "materialBarPillDownloads")).toHaveLength(1);
  expect(pill.root.findAll((node) => node.props.testID === "downloadRingArc")[0]!.props.stroke).toBe(scheme.onSurfaceVariant);
  unmount(pill);
});

test("nothing running means no ring anywhere", () => {
  const root = pageOf("redesigned");
  wait(DOWNLOAD_INDICATOR_DELAY_MS * 2);
  expect(useRunningDownloads.getState().indicatorShown).toBe(false);
  expect(hosts(root, "floatingBarDownloads")).toHaveLength(0);
  unmount(root);
});
