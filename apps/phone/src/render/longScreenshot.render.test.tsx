import { Platform } from "react-native";
import { act, type ReactTestRenderer } from "react-test-renderer";
import "../platform/copy";
import { pages } from "../platform/pages";
import { LongScreenshotHost } from "../components/browsing/LongScreenshotView";
import { PageMenu } from "../components/browsing/PageMenu";
import { DesignProvider } from "../components/ui";
import type { Design } from "../lib/design";
import { handleSystemBack, openPageMenu, pageMenuHidden } from "../state/page/actions";
import { usePageUi } from "../state/page/store";
import { usePages } from "../state/pages/store";
import { useBrowse } from "../state/browse/store";
import { useLongScreenshot } from "../state/longScreenshot/store";
import * as telemetry from "../state/telemetry/telemetry";
import { useTabs } from "../state/tabs/store";
import { useToasts } from "../state/toasts/store";
import { pressButton, renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

const onAndroid = Platform.OS === "android" ? test : test.skip;

const ID = "0f8e2d4c-6b1a-4c3e-9a7d-2b5e8f1c3a90";
const dir = `file:///data/user/0/com.ardia.browser.android/cache/long-screenshots/${ID}`;
const SHOT = {
  id: ID,
  uri: `${dir}/shot.png`,
  path: `/cache/long-screenshots/${ID}/shot.png`,
  width: 1080,
  height: 5000,
  screens: 3,
  tiles: [
    { uri: `${dir}/tile-0.jpg`, top: 0, height: 2048 },
    { uri: `${dir}/tile-1.jpg`, top: 2048, height: 2048 },
    { uri: `${dir}/tile-2.jpg`, top: 4096, height: 904 },
  ],
};
const SAVED = { uri: "content://media/external_primary/images/media/42", width: 1080, height: 5000 };

let taken: jest.SpyInstance;
let saved: jest.SpyInstance;
let shared: jest.SpyInstance;
let discarded: jest.SpyInstance;
let counted: jest.SpyInstance;

const page = (url: string) =>
  usePages.setState((state) => ({ ...state, navigation: { t0: { url, title: "Site 0", canGoBack: false, canGoForward: false, isLoading: false, pageZoom: 1, isDesktopSite: false, blockedRequests: 0 } as never } }));

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  page("https://en.wikipedia.org/wiki/Lisbon");
  useBrowse.setState({ surface: "browsing", sheet: null });
  useLongScreenshot.setState({ stage: { kind: "idle" } });
  jest.spyOn(pages, "canPrint").mockReturnValue(true);
  jest.spyOn(pages, "listsSitePermissions").mockReturnValue(false);
  jest.spyOn(pages, "canTakeLongScreenshot").mockReturnValue(true);
  taken = jest.spyOn(pages, "takeLongScreenshot").mockResolvedValue(SHOT);
  saved = jest.spyOn(pages, "saveLongScreenshot").mockResolvedValue(SAVED);
  shared = jest.spyOn(pages, "shareLongScreenshot").mockResolvedValue(true);
  discarded = jest.spyOn(pages, "discardLongScreenshot").mockResolvedValue(undefined);
  counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function LiveMenu() {
  const open = usePageUi((s) => s.menuOpen);
  return <PageMenu tabId="t0" open={open} onHidden={(token) => pageMenuHidden(token)} />;
}

async function openMenu(design: Design) {
  await act(async () => {
    await openPageMenu();
  });
  return renderSurface(
    <DesignProvider design={design}>
      <LiveMenu />
      <LongScreenshotHost />
    </DesignProvider>,
  );
}

const rowTitles = (root: ReactTestRenderer) =>
  root.root.findAll((node) => typeof node.type === "string" && typeof node.props.testID === "string" && /^(pageMenuRow:|menuToggle:)/.test(node.props.testID)).map((node) => String(node.props.testID).replace(/^(pageMenuRow|menuToggle):/, ""));

const byTestId = (root: ReactTestRenderer, testID: string) => root.root.findAll((node) => typeof node.type === "string" && node.props.testID === testID)[0];

async function pressId(root: ReactTestRenderer, testID: string) {
  const button = root.root.findAll((node) => node.props.testID === testID && typeof node.props.onPress === "function")[0];
  if (!button) throw new Error(`no button ${testID}`);
  await act(async () => {
    button.props.onPress();
  });
}

async function settle() {
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

onAndroid("Long Screenshot sits right after Print in each Android page menu, enabled only on web pages", async () => {
  for (const design of ["redesigned", "original", "material"] as Design[]) {
    const root = await openMenu(design);
    expect(textOf(root)).toContain("Long Screenshot");
    if (design === "redesigned") {
      const rows = rowTitles(root);
      expect(rows[rows.indexOf("Print") + 1]).toBe("Long Screenshot");
    }
    unmount(root);
    act(() => usePageUi.setState({ menuOpen: false }));
  }
});

onAndroid("a private tab's page menu has no Long Screenshot row, and nothing can start one there", async () => {
  useTabs.setState((state) => ({ ...state, open: state.open.map((tab) => ({ ...tab, isPrivate: true })) }));
  const root = await openMenu("redesigned");
  expect(textOf(root)).not.toContain("Long Screenshot");
  expect(textOf(root)).toContain("Print");
  unmount(root);
  expect(taken).not.toHaveBeenCalled();
});

onAndroid("the row waits for the menu to leave, shows the capture, then the preview with both crop edges, and Save counts once", async () => {
  const root = await openMenu("redesigned");
  await pressButton(root, "Long Screenshot");
  expect(usePageUi.getState().menuOpen).toBe(false);
  await settle();
  expect(taken).toHaveBeenCalledWith("t0");
  await settle();
  expect(useLongScreenshot.getState().stage.kind).toBe("preview");
  expect(byTestId(root, "longScreenshotTopEdge")).toBeDefined();
  expect(byTestId(root, "longScreenshotBottomEdge")).toBeDefined();
  expect(textOf(root)).toContain("3 screens");
  await pressId(root, "longScreenshotSave");
  await settle();
  expect(saved).toHaveBeenCalledWith(ID, 0, 5000);
  expect(counted).toHaveBeenCalledWith("long_screenshot_saved");
  expect(byTestId(root, "longScreenshotSaved")).toBeDefined();
  await pressId(root, "longScreenshotShare");
  await settle();
  expect(shared).toHaveBeenCalledWith(SAVED.uri);
  expect(counted).toHaveBeenCalledWith("long_screenshot_shared");
  await pressId(root, "longScreenshotDone");
  expect(useLongScreenshot.getState().stage.kind).toBe("idle");
  expect(discarded).toHaveBeenCalledWith(ID);
  expect(counted).not.toHaveBeenCalledWith("long_screenshot_cancelled");
  unmount(root);
});

onAndroid("Back on the preview cancels it, forgets the capture and counts the cancel", async () => {
  const root = await openMenu("redesigned");
  await pressButton(root, "Long Screenshot");
  await settle();
  await settle();
  expect(useLongScreenshot.getState().stage.kind).toBe("preview");
  act(() => {
    expect(handleSystemBack()).toBe(true);
  });
  expect(useLongScreenshot.getState().stage.kind).toBe("idle");
  expect(discarded).toHaveBeenCalledWith(ID);
  expect(counted).toHaveBeenCalledWith("long_screenshot_cancelled");
  unmount(root);
});

onAndroid("a capture the module refuses or returns malformed shows a short message and counts a failure", async () => {
  taken.mockRejectedValueOnce(new Error("ERR_LONG_SCREENSHOT")).mockResolvedValueOnce({ ...SHOT, tiles: [] });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const root = await openMenu("redesigned");
    await pressButton(root, "Long Screenshot");
    await settle();
    await settle();
    expect(useLongScreenshot.getState().stage.kind).toBe("idle");
    expect(useToasts.getState().toast?.message).toBe("Couldn’t Take a Long Screenshot");
    unmount(root);
    act(() => usePageUi.setState({ menuOpen: false }));
  }
  expect(counted.mock.calls.filter(([field]) => field === "long_screenshot_failed")).toHaveLength(2);
});

onAndroid("a save that fails keeps the preview open to try again", async () => {
  saved.mockResolvedValueOnce(null);
  const root = await openMenu("redesigned");
  await pressButton(root, "Long Screenshot");
  await settle();
  await settle();
  await pressId(root, "longScreenshotSave");
  await settle();
  expect(useLongScreenshot.getState().stage).toMatchObject({ kind: "preview", saving: false });
  expect(useToasts.getState().toast?.message).toBe("Couldn’t Save the Screenshot");
  expect(counted).toHaveBeenCalledWith("long_screenshot_failed");
  expect(counted).not.toHaveBeenCalledWith("long_screenshot_saved");
  unmount(root);
});
