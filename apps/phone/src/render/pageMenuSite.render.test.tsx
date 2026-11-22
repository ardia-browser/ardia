import { act } from "react-test-renderer";
import { PageMenu } from "../components/browsing/PageMenu";
import { DesignProvider } from "../components/ui";
import { handleSystemBack, openPageMenu } from "../state/page/actions";
import { usePageUi } from "../state/page/store";
import { usePages } from "../state/pages/store";
import { useSettingsNav } from "../state/settings/nav";
import { useBrowse } from "../state/browse/store";
import { useTabs } from "../state/tabs/store";
import { selectedTab } from "../state/tabs/tabsState";
import { pressButton, renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  usePages.setState((state) => ({ ...state, navigation: { t0: { url: "https://site0.example/", title: "Site 0", canGoBack: false, canGoForward: false, isLoading: false, pageZoom: 1, isDesktopSite: false, blockedRequests: 0 } as never } }));
  useBrowse.setState({ surface: "browsing", sheet: null });
  useSettingsNav.setState({ open: false, stack: [{ page: "root" }], popping: false });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

async function openMenu() {
  await act(async () => {
    await openPageMenu();
  });
  return renderSurface(
    <DesignProvider design="original">
      <PageMenu tabId={selectedTab(useTabs.getState())!.id} open onHidden={() => undefined} />
    </DesignProvider>,
  );
}

test("Site Settings opens inside the menu with a Back button, and Back returns to the menu", async () => {
  const root = await openMenu();
  expect(textOf(root)).toContain("Find on Page");
  await pressButton(root, "Site Settings");
  act(() => jest.runOnlyPendingTimers());
  expect(usePageUi.getState().menuOpen).toBe(true);
  expect(useSettingsNav.getState().open).toBe(false);
  expect(textOf(root)).toContain("Block Cookie Banners");
  expect(textOf(root)).not.toContain("Find on Page");
  const back = root.root.findAll((node) => node.props.accessibilityLabel === "Back" && typeof node.props.onPress === "function")[0]!;
  await act(async () => back.props.onPress());
  act(() => jest.runOnlyPendingTimers());
  expect(textOf(root)).toContain("Find on Page");
  expect(usePageUi.getState().menuOpen).toBe(true);
  unmount(root);
});

test("system Back on the menu's Site Settings returns to the menu instead of closing it, and the menu reopens on its main page", async () => {
  const root = await openMenu();
  await pressButton(root, "Site Settings");
  act(() => {
    handleSystemBack();
  });
  expect(usePageUi.getState().menuOpen).toBe(true);
  expect(usePageUi.getState().menuPage).toBe("main");
  await pressButton(root, "Site Settings");
  act(() => usePageUi.setState({ menuOpen: false }));
  await act(async () => {
    await openPageMenu();
  });
  expect(usePageUi.getState().menuPage).toBe("main");
  unmount(root);
});

test("Filter Lists from the menu's Site Settings closes the menu and opens Settings there", async () => {
  const root = await openMenu();
  await pressButton(root, "Site Settings");
  act(() => jest.runOnlyPendingTimers());
  await pressButton(root, "Filter Lists");
  expect(usePageUi.getState().menuOpen).toBe(false);
  expect(useSettingsNav.getState().open).toBe(true);
  expect(useSettingsNav.getState().stack.at(-1)).toEqual({ page: "filterLists" });
  unmount(root);
});
