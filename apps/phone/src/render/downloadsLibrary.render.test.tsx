import { Platform, StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { LibraryNavigation } from "../components/library/ExpoLibrary";
import { LibraryView } from "../components/library/LibraryView";
import { MaterialLibrary } from "../components/library/MaterialLibrary";
import { DesignProvider } from "../components/ui";
import { downloads } from "../platform/downloads";
import { forgetRunningDownloads, noteDownloadsReported, noteDownloadStarted, useRunningDownloads } from "../state/downloads/running";
import * as library from "../state/library/store";
import { openLibrary, showLibrarySection, useLibrary } from "../state/library/store";
import { downloadFinished, downloadStarted, forgetDownloadCards } from "../state/page/downloadCards";
import { dismissToast, useToasts } from "../state/toasts/store";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

const telemetry = require("../state/telemetry/telemetry") as typeof import("../state/telemetry/telemetry");

type Root = ReturnType<typeof renderSurface>;

let cancel: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  forgetRunningDownloads();
  forgetDownloadCards();
  useToasts.setState({ toast: null });
  useLibrary.setState({ open: false, section: "history", alone: false, path: [], history: [], historyLoaded: true, files: [], filesLoaded: true });
  jest.spyOn(library, "loadHistory").mockImplementation(() => undefined);
  jest.spyOn(library, "loadDownloads").mockImplementation(async () => undefined);
  jest.spyOn(downloads, "active").mockImplementation(async () => []);
  cancel = jest.spyOn(downloads, "cancel").mockImplementation(() => Promise.resolve());
  cancel.mockClear();
  jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined).mockClear();
});

afterEach(() => {
  act(() => dismissToast());
  act(() => forgetRunningDownloads());
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const NOW = Date.now();
const file = (index: number) => ({ name: `report-${index}.pdf`, uri: `file:///downloads/report-${index}.pdf`, size: 1_200_000, modified: NOW, kind: "pdf" as const });
const hosts = (root: Root, has: (props: Record<string, unknown>) => boolean) => root.root.findAll((node: ReactTestInstance) => typeof node.type === "string" && has(node.props));
const byId = (root: Root, testID: string) => hosts(root, (props) => props.testID === testID);
const pressOf = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.props.onPress === "function")[0]!;
const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
const counts = () => (telemetry.countUsage as unknown as jest.Mock).mock.calls.map(([field]) => field as string).filter((field) => /download/.test(field));

const running = () => {
  act(() => {
    downloadStarted({ name: "page.download", pageId: "t0", downloadId: "17", url: "https://files.example/otter.pdf", fileName: "otter.pdf", mimeType: "application/pdf", contentLength: 2_700_000, isPrivate: false });
    noteDownloadsReported([{ id: "17", fileName: "otter.pdf", bytes: 1_200_000, total: 2_700_000, fraction: 0.444, isQueued: false }]);
    useLibrary.setState({ files: [file(0)] });
  });
};

const textIn = (root: Root) => textOf(root);

test("Downloads opened from a download stands alone: titled Downloads with no History or Bookmarks switcher, and no way to switch from there", () => {
  const root = renderSurface(<LibraryView />);
  act(() => openLibrary("downloads", { alone: true }));
  expect(byId(root, "librarySwitcher")).toHaveLength(0);
  expect(textIn(root)).toContain("Downloads");
  act(() => showLibrarySection("history"));
  expect(useLibrary.getState().section).toBe("downloads");
  unmount(root);
});

test("Downloads opened from the deck menu keeps the switcher, as History and Bookmarks do", () => {
  const root = renderSurface(<LibraryView />);
  act(() => openLibrary("downloads"));
  expect(byId(root, "librarySwitcher")).toHaveLength(1);
  act(() => showLibrarySection("history"));
  expect(useLibrary.getState()).toMatchObject({ section: "history", alone: false });
  unmount(root);
});

test("running downloads come first, under In progress, with the file name, how far it is, a thin bar and a cancel button", () => {
  const root = renderSurface(<LibraryView />);
  act(() => openLibrary("downloads", { alone: true }));
  running();
  const rows = byId(root, "libraryRunningRow");
  expect(rows).toHaveLength(1);
  expect(textIn(root)).toContain("In progress");
  expect(textIn(root)).toContain("44% · 1.2 MB of 2.7 MB");
  expect(textIn(root)).toContain("report-0.pdf");
  expect(textIn(root).indexOf("otter.pdf")).toBeLessThan(textIn(root).indexOf("report-0.pdf"));
  expect(StyleSheet.flatten(byId(root, "libraryRunningBar")[0]!.props.style).width).toBe("44%");
  expect(root.root.findAll((node) => node.props.testID === "libraryRunningCancel" && node.props.label === "Cancel otter.pdf").length).toBeGreaterThan(0);
  unmount(root);
});

test("cancel in the list stops the download, drops its row, counts it, and raises no failure card", async () => {
  const root = renderSurface(<LibraryView />);
  act(() => openLibrary("downloads", { alone: true }));
  running();
  act(() => pressOf(root, "libraryRunningCancel").props.onPress());
  await settle();
  expect(cancel).toHaveBeenCalledWith("17");
  expect(byId(root, "libraryRunningRow")).toHaveLength(0);
  act(() => downloadFinished({ name: "downloads.finished", id: "17", fileName: "otter.pdf", uri: null, failure: "network" }));
  expect(useToasts.getState().toast).toBeNull();
  expect(counts()).toEqual(["downloads_cancelled"]);
  unmount(root);
});

test("opening Downloads asks the system for what is already running, so a download started before the list shows up in it", async () => {
  (downloads.active as unknown as jest.Mock).mockImplementation(async () => [{ id: "9", fileName: "early.zip", bytes: 10, total: null, fraction: null, isQueued: false }]);
  const root = renderSurface(<LibraryView />);
  act(() => openLibrary("downloads", { alone: true }));
  await settle();
  expect(useRunningDownloads.getState().running.map((row) => row.id)).toEqual(["9"]);
  expect(textIn(root)).toContain("early.zip");
  expect(textIn(root)).toContain("10 bytes so far");
  unmount(root);
});

const onAndroid = Platform.OS === "android" ? test : test.skip;
const onIos = Platform.OS === "ios" ? test : test.skip;

onAndroid("Material You's Downloads alone drops the primary tabs, and its running row cancels the same way", async () => {
  const root = renderSurface(
    <DesignProvider design="material">
      <MaterialLibrary />
    </DesignProvider>,
  );
  act(() => openLibrary("downloads", { alone: true }));
  running();
  expect(byId(root, "materialLibraryTabs")).toHaveLength(0);
  expect(byId(root, "materialLibraryRunningRow")).toHaveLength(1);
  expect(StyleSheet.flatten(byId(root, "materialLibraryRunningBar")[0]!.props.style).width).toBe("44%");
  act(() => pressOf(root, "materialLibraryRunningCancel").props.onPress());
  await settle();
  expect(cancel).toHaveBeenCalledWith("17");
  expect(byId(root, "materialLibraryRunningRow")).toHaveLength(0);
  act(() => openLibrary("downloads"));
  expect(byId(root, "materialLibraryTabs")).toHaveLength(1);
  unmount(root);
});

onIos("iPhone's Downloads alone has no segmented switcher in the toolbar and lists the running download first", () => {
  const root = renderSurface(<LibraryNavigation />);
  act(() => openLibrary("downloads", { alone: true }));
  running();
  expect(root.root.findAll((node) => node.props.placement === "principal")).toHaveLength(0);
  expect(root.root.findAll((node) => node.props.children === "In progress").length).toBeGreaterThan(0);
  expect(root.root.findAll((node) => node.props.label === "Cancel otter.pdf").length).toBeGreaterThan(0);
  act(() => openLibrary("downloads"));
  expect(root.root.findAll((node) => node.props.placement === "principal").length).toBeGreaterThan(0);
  unmount(root);
});

test("a private download's row cancels without counting", async () => {
  const root = renderSurface(<LibraryView />);
  act(() => openLibrary("downloads", { alone: true }));
  act(() => {
    noteDownloadStarted("5", "secret.pdf", true, 100);
    noteDownloadsReported([{ id: "5", fileName: "secret.pdf", bytes: 10, total: 100, fraction: 0.1, isQueued: false }]);
  });
  act(() => pressOf(root, "libraryRunningCancel").props.onPress());
  await settle();
  expect(cancel).toHaveBeenCalledWith("5");
  expect(counts()).toEqual([]);
  unmount(root);
});
