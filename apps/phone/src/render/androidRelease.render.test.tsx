import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { PageMenu } from "../components/browsing/PageMenu";
import { DesignProvider } from "../components/ui";
import { pages } from "../platform/pages";
import { useArchiveCard } from "../state/browse/archiveCard";
import { markSheetFromSettings, openArchive, useBrowse } from "../state/browse/store";
import { showOnboardingFromSettings, useOnboarding } from "../state/onboarding/store";
import { handleSystemBack, openPageMenu, pageMenuHidden } from "../state/page/actions";
import { usePageUi } from "../state/page/store";
import { usePages } from "../state/pages/store";
import { searchState } from "../state/search/store";
import { currentTabs } from "../state/tabs/store";
import { closeSettings, openSettings, useSettingsNav } from "../state/settings/nav";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

const onAndroid = Platform.OS === "android" ? test : test.skip;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  act(() => {
    useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
    useSettingsNav.setState({ open: false, stack: [{ page: "root" }], popping: false });
    useArchiveCard.setState({ showing: false });
    useOnboarding.setState({ showing: false, step: "welcome", forward: true, fromSettings: false });
  });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  act(() => closeSettings());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

onAndroid("Back on the deck leaves the app, as Compose's deck had no Back of its own, once the Archive capsule is put away", () => {
  act(() => useBrowse.setState({ surface: "deck" }));
  act(() => useArchiveCard.setState({ showing: true }));
  let handled = false;
  act(() => void (handled = handleSystemBack()));
  expect(handled).toBe(true);
  expect(useArchiveCard.getState().showing).toBe(false);
  act(() => void (handled = handleSystemBack()));
  expect(handled).toBe(false);
  expect(useBrowse.getState().surface).toBe("deck");
});

onAndroid("Back from an Archive opened in Settings goes back to Settings, and from one opened anywhere else it doesn't", () => {
  act(() => openSettings());
  act(() => closeSettings());
  act(() => openArchive());
  act(() => markSheetFromSettings());
  act(() => void handleSystemBack());
  expect(useBrowse.getState().sheet).toBeNull();
  expect(useSettingsNav.getState().open).toBe(true);
  act(() => closeSettings());
  act(() => openArchive());
  act(() => void handleSystemBack());
  expect(useBrowse.getState().sheet).toBeNull();
  expect(useSettingsNav.getState().open).toBe(false);
});

onAndroid("Back on the first step of onboarding opened from Settings goes back to Settings, without raising the search tray", () => {
  act(() => openSettings());
  act(() => showOnboardingFromSettings());
  expect(useOnboarding.getState()).toMatchObject({ showing: true, fromSettings: true });
  act(() => useOnboarding.setState({ step: "welcome" }));
  act(() => void handleSystemBack());
  expect(useOnboarding.getState().showing).toBe(false);
  expect(useSettingsNav.getState().open).toBe(true);
  expect(searchState().open).toBe(false);
});

function LiveMenu() {
  const open = usePageUi((s) => s.menuOpen);
  return <PageMenu tabId="t0" open={open} onHidden={() => undefined} />;
}

onAndroid("Android's page menu offers Print on a web page where the page engine can print", async () => {
  act(() => usePages.setState((state) => ({ ...state, navigation: { t0: { url: "https://site0.example/", title: "Site 0", canGoBack: false, canGoForward: false, isLoading: false, pageZoom: 1, isDesktopSite: false, blockedRequests: 0 } as never } })));
  const canPrint = jest.spyOn(pages, "canPrint").mockReturnValue(true);
  const printed = jest.spyOn(pages, "print").mockResolvedValue(true);
  const root = renderSurface(<DesignProvider design="original"><LiveMenu /></DesignProvider>);
  await act(async () => {
    await openPageMenu();
  });
  act(() => jest.advanceTimersByTime(500));
  expect(textOf(root)).toContain("Print");
  const row = root.root.findAll((node) => typeof node.props.onPress === "function" && node.findAll((inner) => inner.props.children === "Print").length > 0).at(-1)!;
  act(() => row.props.onPress());
  expect(usePageUi.getState().menuOpen).toBe(false);
  await act(async () => {
    pageMenuHidden();
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  });
  expect(printed).toHaveBeenCalledWith(currentTabs().selectedId);
  unmount(root);
  canPrint.mockReturnValue(false);
  const without = renderSurface(<DesignProvider design="original"><LiveMenu /></DesignProvider>);
  await act(async () => {
    await openPageMenu();
  });
  act(() => jest.advanceTimersByTime(500));
  expect(textOf(without)).not.toContain("Print");
  unmount(without);
});
