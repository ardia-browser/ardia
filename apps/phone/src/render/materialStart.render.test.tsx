import { Platform, StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { StartScreen } from "../components/search/StartScreen";
import { materialStartMs } from "../components/search/MaterialStart";
import { Backdrop } from "../components/ui/Backdrop";
import { DesignProvider } from "../components/ui";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { setDynamicScheme } from "../state/app/dynamicScheme";
import * as browse from "../state/browse/store";
import { dismissSearch, presentSearch } from "../state/search/store";
import { useTabs } from "../state/tabs/store";
import { currentPreferences, setPreference } from "../state/settings/store";
import { renderSurface, unmount, withTabs, withMaterialYou } from "../../test/render/harness";

withMaterialYou();

const onAndroid = Platform.OS === "android" ? test : test.skip;
const LIGHT = SEEDED_SCHEMES.ardia.light;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(0);
  setDynamicScheme(null);
  act(() => browse.useBrowse.setState({ surface: "start", sheet: null }));
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  act(() => useTabs.setState({ incognito: false }));
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const node = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.type === "string")[0];
const pressable = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.props.onPress === "function" && found.props.android_ripple !== undefined)[0]!;
const flat = (found: ReactTestInstance | undefined) => StyleSheet.flatten(found?.props.style) ?? {};

const start = () =>
  renderSurface(
    <DesignProvider design="material">
      <StartScreen />
    </DesignProvider>,
  );

onAndroid("the material start screen is the scheme's surfaces, a top app bar of 48 dp icon buttons, the centred logo, and a Material bottom search bar like the web URL bar", () => {
  const root = start();
  expect(node(root, "materialStart")).toBeDefined();
  expect(root.root.findAll((found) => found.type === Backdrop)[0]!.props.colors).toEqual([LIGHT.surface, LIGHT.surfaceContainerLow]);
  for (const label of ["Archive", "New Incognito Tab", "Settings"]) {
    expect(flat(node(root, `materialStart:${label}`))).toMatchObject({ width: 48, height: 48 });
    expect(pressable(root, `materialStart:${label}`).props.android_ripple).toMatchObject({ borderless: true });
  }
  expect(node(root, "materialStartCenter")!.findAll((found) => found.props.testID === "materialStartSearch")).toHaveLength(0);
  expect(flat(node(root, "materialStartBottomBar"))).toMatchObject({
    position: "absolute",
    bottom: 32,
    left: 16,
    right: 16,
    height: 64,
    borderRadius: 9999,
    backgroundColor: "transparent",
    elevation: 0,
  });
  expect(node(root, "materialStartBottomBar")!.findAll((found) => found.props.testID === "materialStartSearch").length).toBeGreaterThan(0);
  expect(flat(node(root, "materialStartSearch"))).toMatchObject({ height: 48, borderRadius: 9999, backgroundColor: LIGHT.surfaceContainerHigh });
  expect(pressable(root, "materialStartSearch").props.android_ripple).toMatchObject({ borderless: false });
  expect(node(root, "startDeckBar")).toBeUndefined();
  unmount(root);
});

onAndroid("the search bar opens a new tab's search, and the bar's buttons are the plus menu's actions laid out where they can be seen", () => {
  const tab = jest.spyOn(browse, "newTab").mockImplementation(() => undefined);
  const incognito = jest.spyOn(browse, "newIncognitoTab").mockImplementation(() => undefined);
  const archive = jest.spyOn(browse, "openArchive").mockImplementation(() => undefined);
  const root = start();
  act(() => {
    pressable(root, "materialStartSearch").props.onPress();
  });
  act(() => {
    pressable(root, "materialStart:New Incognito Tab").props.onPress();
  });
  act(() => {
    pressable(root, "materialStart:Archive").props.onPress();
  });
  expect(tab).toHaveBeenCalled();
  expect(incognito).toHaveBeenCalled();
  expect(archive).toHaveBeenCalled();
  unmount(root);
});

onAndroid("with tabs open the leading button is Tabs, and it shows the deck", () => {
  withTabs(2);
  act(() => browse.useBrowse.setState({ surface: "start", sheet: null }));
  const deck = jest.spyOn(browse, "showDeck").mockImplementation(() => Promise.resolve());
  const root = start();
  expect(flat(node(root, "materialStartBottomBar"))).toMatchObject({ backgroundColor: LIGHT.surfaceContainer, elevation: 3 });
  act(() => {
    pressable(root, "materialStart:Tabs").props.onPress();
  });
  expect(deck).toHaveBeenCalled();
  unmount(root);
});

onAndroid.each(["light", "dark"] as const)("in Incognito the start screen stays dark with %s appearance", (appearance) => {
  const previous = currentPreferences().schemeChoice;
  act(() => setPreference("schemeChoice", appearance));
  act(() => useTabs.setState({ incognito: true }));
  const root = start();
  expect(flat(node(root, "materialStartBackdrop")).backgroundColor).toBe("#000000");
  expect(flat(node(root, "materialStartBottomBar"))).toMatchObject({ backgroundColor: "transparent", elevation: 0 });
  expect(flat(node(root, "materialStartSearch")).backgroundColor).toBe("#000000");
  expect(root.root.findAll((found) => found.props.children === "You’re browsing Incognito").length).toBeGreaterThan(0);
  expect(node(root, "materialStart:New Tab")).toBeDefined();
  unmount(root);
  act(() => setPreference("schemeChoice", previous));
});

onAndroid("while search is open the start screen's controls leave touch and TalkBack, and they fade through on Material's timings", () => {
  const root = start();
  act(() => presentSearch("start", ""));
  for (const id of ["materialStartTopBar", "materialStartCenter", "materialStartBottomBar"]) {
    expect(node(root, id)!.props).toMatchObject({ pointerEvents: "none", importantForAccessibility: "no-hide-descendants", accessibilityElementsHidden: true });
  }
  expect(materialStartMs(true, true)).toBe(0);
  expect(materialStartMs(false, true)).toBe(100);
  expect(materialStartMs(false, false)).toBe(150);
  unmount(root);
});
