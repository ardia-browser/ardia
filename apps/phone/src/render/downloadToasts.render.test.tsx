import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { ToastHost } from "../components/toasts/ToastHost";
import { downloads } from "../platform/downloads";
import { pages } from "../platform/pages";
import * as browse from "../state/browse/store";
import { startPageUi } from "../state/page/actions";
import { cancelDownload, forgetDownloadCards } from "../state/page/downloadCards";
import { DOWNLOAD_INDICATOR_DELAY_MS } from "../state/downloads/runningRules";
import { forgetRunningDownloads, useRunningDownloads } from "../state/downloads/running";
import { useLibrary } from "../state/library/store";
import { dismissToast, tapToast, useToasts } from "../state/toasts/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const telemetry = require("../state/telemetry/telemetry") as typeof import("../state/telemetry/telemetry");

type Listener = (event: { name: string; [key: string]: unknown }) => void;

const pageListeners: Listener[] = [];
const downloadListeners: Listener[] = [];

jest.spyOn(pages, "addListener").mockImplementation((listener: unknown) => {
  pageListeners.push(listener as Listener);
  return { remove: () => undefined } as never;
});
jest.spyOn(downloads, "addListener").mockImplementation((listener: unknown) => {
  downloadListeners.push(listener as Listener);
  return { remove: () => undefined } as never;
});

let cancel: jest.SpyInstance;
let retried: jest.SpyInstance;
let opened: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  browse.startBrowser();
  startPageUi();
  forgetDownloadCards();
  forgetRunningDownloads();
  useToasts.setState({ toast: null });
  useLibrary.setState({ open: false });
  jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined).mockClear();
  cancel = jest.spyOn(downloads, "cancel").mockImplementation(() => Promise.resolve());
  cancel.mockClear();
  retried = jest.spyOn(pages, "download").mockImplementation(() => Promise.resolve());
  retried.mockClear();
  opened = jest.spyOn(downloads, "open").mockImplementation(() => Promise.resolve(true));
  opened.mockClear();
  jest.spyOn(downloads, "installsPackages").mockImplementation(() => false);
});

afterEach(() => {
  act(() => dismissToast());
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const page = (fields: Record<string, unknown>) =>
  act(() => pageListeners.forEach((listener) => listener({ name: "page.download", pageId: "t0", downloadId: "17", url: "https://files.example/otter.pdf", fileName: "otter.pdf", mimeType: "application/pdf", contentLength: 1_234_567, isPrivate: false, ...fields })));
const progress = (id: string, fraction: number | null, total: number | null = 1_234_567) =>
  act(() => downloadListeners.forEach((listener) => listener({ name: "downloads.progress", downloads: [{ id, fileName: "otter.pdf", bytes: Math.round((fraction ?? 0) * (total ?? 0)), total, fraction, isQueued: false }] })));
const finished = (fields: Record<string, unknown>) => act(() => downloadListeners.forEach((listener) => listener({ name: "downloads.finished", id: "17", fileName: "otter.pdf", uri: "content://downloads/17", failure: null, ...fields })));
const wait = (ms: number) => act(() => jest.advanceTimersByTime(ms));
const toast = () => useToasts.getState().toast;
const counts = () => (telemetry.countUsage as unknown as jest.Mock).mock.calls.map(([field]) => field as string).filter((field) => /download/.test(field));
const settle = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

test("a fast download shows nothing while it runs and then one finished card: file tile, size and site, and Open", async () => {
  const shown = jest.fn();
  const unsubscribe = useToasts.subscribe((state) => state.toast && shown(state.toast.id));
  const root = renderSurface(<ToastHost />);
  page({});
  wait(DOWNLOAD_INDICATOR_DELAY_MS - 100);
  expect(toast()).toBeNull();
  finished({});
  expect(toast()).toMatchObject({ title: "otter.pdf", detail: "Downloaded · 1.2 MB · files.example", tile: { kind: "file", ext: "pdf" }, stage: "done", durationMs: 5000 });
  expect(toast()!.action!.label).toBe("Open");
  expect(root.root.findAll((node) => node.props.testID === "toastTile" && typeof node.type === "string")).toHaveLength(1);
  wait(DOWNLOAD_INDICATOR_DELAY_MS);
  expect(new Set(shown.mock.calls.map(([id]) => id)).size).toBe(1);
  act(() => tapToast());
  await settle();
  expect(opened).toHaveBeenCalledWith("content://downloads/17");
  expect(counts()).not.toContain("download_cards_updated");
  unsubscribe();
  unmount(root);
});

test("a slow download raises no card while it runs, only the ring in the bar, and then one finished card", () => {
  const shown = jest.fn();
  const unsubscribe = useToasts.subscribe((state) => state.toast && shown(state.toast.stage));
  const root = renderSurface(<ToastHost />);
  page({});
  wait(DOWNLOAD_INDICATOR_DELAY_MS);
  progress("17", 0.456);
  wait(10_000);
  expect(toast()).toBeNull();
  expect(useRunningDownloads.getState().indicatorShown).toBe(true);
  finished({});
  expect(toast()).toMatchObject({ key: "download:17", title: "otter.pdf", detail: "Downloaded · 1.2 MB · files.example", stage: "done" });
  expect(useRunningDownloads.getState()).toMatchObject({ running: [], indicatorShown: false });
  expect(shown.mock.calls.map(([stage]) => stage)).toEqual(["done"]);
  expect(counts()).toEqual([]);
  unsubscribe();
  unmount(root);
});

test("cancelling a download stops it, takes it off the ring, counts it, and its own failure never shows", async () => {
  page({});
  wait(DOWNLOAD_INDICATOR_DELAY_MS);
  act(() => cancelDownload("17"));
  await settle();
  expect(cancel).toHaveBeenCalledWith("17");
  expect(useRunningDownloads.getState().running).toEqual([]);
  finished({ failure: "network", uri: null });
  expect(toast()).toBeNull();
  expect(counts()).toEqual(["downloads_cancelled"]);
});

test("a failure leads with the headline, gives the reason on the second line, and offers Retry that downloads the same link again under the same name", async () => {
  const root = renderSurface(<ToastHost />);
  page({});
  wait(DOWNLOAD_INDICATOR_DELAY_MS);
  finished({ failure: "server", uri: null });
  expect(toast()).toMatchObject({ key: "download:17", title: "Couldn’t download otter.pdf", detail: "The site didn’t send the file.", tile: { kind: "icon", icon: "warning" }, titleLines: 2, icon: "warning" });
  expect(toast()!.action!.label).toBe("Retry");
  act(() => tapToast());
  await settle();
  expect(retried).toHaveBeenCalledWith("t0", "https://files.example/otter.pdf", "otter.pdf");
  expect(counts()).toEqual(["downloads_retried"]);
  unmount(root);
});

test("a retried download keeps the file's own name and its card, even when the link alone names it differently", async () => {
  const root = renderSurface(<ToastHost />);
  page({});
  wait(DOWNLOAD_INDICATOR_DELAY_MS);
  finished({ failure: "server", uri: null });
  expect(toast()!.action!.label).toBe("Retry");
  act(() => tapToast());
  await settle();
  page({ downloadId: "18", fileName: "otter" });
  finished({ id: "18", fileName: "otter", failure: "server", uri: null });
  expect(toast()).toMatchObject({ key: "download:17", title: "Couldn’t download otter.pdf", detail: "The site didn’t send the file." });
  unmount(root);
});

test("a failure that retrying can't help, or one from a private page, offers no Retry", () => {
  page({ downloadId: "18" });
  finished({ id: "18", failure: "noSpace", uri: null });
  expect(toast()).toMatchObject({ detail: "Your phone is out of space.", action: null });
  page({ downloadId: "19", isPrivate: true });
  finished({ id: "19", failure: "network", uri: null });
  expect(toast()).toMatchObject({ detail: "Check your connection and try again.", action: null });
});

test("a download refused at the start says it couldn't on a warning tile", () => {
  page({ downloadId: null, fileName: "seal.zip" });
  expect(toast()).toMatchObject({ title: "Couldn’t download seal.zip", icon: "warning", tile: { kind: "icon", icon: "warning" } });
});

test("a second download finishing while the first's card is up merges into one card that counts them, and Show opens Downloads", () => {
  const root = renderSurface(<ToastHost />);
  page({});
  page({ downloadId: "18", fileName: "b.zip", url: "https://files.example/b.zip" });
  finished({});
  const first = toast()!.id;
  finished({ id: "18", fileName: "b.zip", uri: "content://downloads/18" });
  expect(toast()).toMatchObject({ id: first, title: "2 downloads complete", detail: "otter.pdf, b.zip", tile: { kind: "count", count: 2 } });
  expect(toast()!.action!.label).toBe("Show");
  page({ downloadId: "20", fileName: "c.png", url: "https://files.example/c.png" });
  finished({ id: "20", fileName: "c.png" });
  expect(toast()).toMatchObject({ id: first, title: "3 downloads complete", detail: "otter.pdf, b.zip, c.png" });
  act(() => tapToast());
  expect(useLibrary.getState()).toMatchObject({ open: true, section: "downloads", alone: true });
  expect(counts()).toEqual(["download_cards_grouped", "download_cards_grouped"]);
  unmount(root);
});

test("an Incognito download's card names the file as before but never its site, and counts nothing", () => {
  const root = renderSurface(<ToastHost />);
  page({ isPrivate: true });
  wait(DOWNLOAD_INDICATOR_DELAY_MS);
  progress("17", 0.5);
  finished({});
  expect(toast()).toMatchObject({ title: "otter.pdf", detail: "Downloaded · 1.2 MB" });
  page({ downloadId: "18", fileName: "b.zip", isPrivate: true });
  finished({ id: "18", fileName: "b.zip" });
  expect(toast()!.title).toBe("2 downloads complete");
  expect(counts()).toEqual([]);
  unmount(root);
});

test("an event with no id still finds its download by file name, so the card knows its size and site and the ring lets it go", () => {
  page({});
  wait(DOWNLOAD_INDICATOR_DELAY_MS);
  finished({ id: undefined });
  expect(toast()).toMatchObject({ key: "download:17", detail: "Downloaded · 1.2 MB · files.example", stage: "done" });
  expect(useRunningDownloads.getState().running).toEqual([]);
});

test("ending incognito with three private downloads in flight gives one toast for all of them, as Compose's", () => {
  const shown = jest.fn();
  const unsubscribe = useToasts.subscribe((state) => state.toast && shown(state.toast.message));
  for (let index = 0; index < 3; index++) finished({ id: `p${index}`, fileName: `private-${index}.zip`, failure: "privateSessionEnded", uri: null });
  wait(300);
  expect(shown.mock.calls.map(([message]) => message)).toEqual(["Stopped 3 Private Downloads"]);
  expect(toast()?.icon).toBe("warning");
  finished({ id: "99", failure: "network", uri: null });
  expect(toast()?.title).toBe("Couldn’t download otter.pdf");
  unsubscribe();
});

const notice = (name: string, id: string) => act(() => downloadListeners.forEach((listener) => listener({ name, id })));

test("Cancel in a download's Android notification ends it like the Downloads row: the ring lets it go and no failure card follows", () => {
  page({});
  wait(DOWNLOAD_INDICATOR_DELAY_MS);
  expect(useRunningDownloads.getState().running.map((row) => row.id)).toEqual(["17"]);
  notice("downloads.cancelled", "17");
  expect(useRunningDownloads.getState().running).toEqual([]);
  finished({ failure: "network", uri: null });
  expect(toast()).toBeNull();
});

test("Retry in a failed download's notification runs the card's own retry, once, keeping the file's name", async () => {
  page({});
  finished({ failure: "server", uri: null });
  act(() => dismissToast());
  notice("downloads.retryRequested", "17");
  await settle();
  expect(retried).toHaveBeenCalledWith("t0", "https://files.example/otter.pdf", "otter.pdf");
  notice("downloads.retryRequested", "17");
  await settle();
  expect(retried).toHaveBeenCalledTimes(1);
  page({ downloadId: "18", fileName: "otter" });
  finished({ id: "18", fileName: "otter", failure: "server", uri: null });
  expect(toast()!.title).toBe("Couldn’t download otter.pdf");
});

test("a download that can't be retried ignores a retry request", async () => {
  page({ isPrivate: true });
  finished({ failure: "network", uri: null });
  notice("downloads.retryRequested", "17");
  await settle();
  expect(retried).not.toHaveBeenCalled();
});

test("on Android the first download asks once for notifications, the way an app update does, and never again", async () => {
  const asked = jest.spyOn(downloads, "askForDownloadNotifications").mockImplementation(() => Promise.resolve(true));
  asked.mockClear();
  page({});
  page({ downloadId: "18", fileName: "b.zip" });
  await settle();
  expect(asked).toHaveBeenCalledTimes(Platform.OS === "android" ? 1 : 0);
});
