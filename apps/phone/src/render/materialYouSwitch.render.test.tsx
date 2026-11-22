import { Platform, ScrollView, Text } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import { DesignProvider, Portal, useDesign } from "../components/ui";
import * as coverFocus from "../components/ui/coverFocus";
import { MaterialBottomBar } from "../components/ui/MaterialBottomBar";
import { pages } from "../platform/pages";
import { useBrowse } from "../state/browse/store";
import { closeSettings, openSettings, settingsScroll } from "../state/settings/nav";
import { currentPreferences, usePreferences } from "../state/settings/store";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, unmount, updateSurface, withTabs } from "../../test/render/harness";

const onAndroid = Platform.OS === "android" ? test : test.skip;
const onIPhone = Platform.OS === "ios" ? test : test.skip;

let counted: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  usePreferences.setState({ materialYou: false });
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null, veiled: null });
  jest.spyOn(pages, "listsSitePermissions").mockReturnValue(false);
  counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => closeSettings());
  act(() => jest.runOnlyPendingTimers());
  usePreferences.setState({ materialYou: false });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const materialYouRow = (root: Root): ReactTestInstance | undefined =>
  root.root.findAll((node) => node.props.accessibilityLabel === "Material You" && node.props.accessibilityRole === "switch" && typeof node.props.onPress === "function")[0];
const materialBars = (root: Root) => root.root.findAll((node) => node.type === MaterialBottomBar);
const settle = () => {
  for (let frame = 0; frame < 30; frame++) act(() => jest.advanceTimersByTime(16));
};

onAndroid("Material You is off by default: the page keeps main's bar, and Settings offers the switch unchecked", () => {
  expect(currentPreferences().materialYou).toBe(false);
  const root = renderSurface(<Surfaces />);
  expect(materialBars(root)).toHaveLength(0);
  act(() => openSettings());
  settle();
  const row = materialYouRow(root);
  expect(row).toBeDefined();
  expect(row!.props.accessibilityState).toMatchObject({ checked: false });
  unmount(root);
});

onAndroid("turning Material You on changes the whole app at once, without a relaunch, and turning it off brings main's design back; each flip is counted", () => {
  const root = renderSurface(<Surfaces />);
  act(() => openSettings());
  settle();
  const sheet = root.root.findAll((node) => node.props.testID === "fullSheet" && typeof node.type === "string")[0];
  const scroll = root.root.findAll((node) => node.props.testID === "settingsPage" && typeof node.type === "string")[0]!.findAll((node) => node.type === ScrollView)[0]!;
  act(() => scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 120 } } }));
  act(() => materialYouRow(root)!.props.onPress());
  settle();
  expect(root.root.findAll((node) => node.props.testID === "fullSheet" && typeof node.type === "string")[0]).toBe(sheet);
  expect(root.root.findAll((node) => node.props.testID === "settingsPage" && typeof node.type === "string")[0]!.findAll((node) => node.type === ScrollView)[0]!).toBe(scroll);
  expect(settingsScroll("Settings")).toBe(120);
  expect(currentPreferences().materialYou).toBe(true);
  expect(counted).toHaveBeenCalledWith("material_you_turned_on");
  expect(root.root.findAll((node) => node.props.testID === "materialSettingsPage" && typeof node.type === "string")).toHaveLength(1);
  expect(materialBars(root)).toHaveLength(1);
  expect(materialYouRow(root)).toBeDefined();
  act(() => materialYouRow(root)!.props.onPress());
  settle();
  expect(root.root.findAll((node) => node.props.testID === "settingsPage" && typeof node.type === "string")[0]!.findAll((node) => node.type === ScrollView)[0]!).toBe(scroll);
  expect(settingsScroll("Settings")).toBe(120);
  expect(currentPreferences().materialYou).toBe(false);
  expect(counted).toHaveBeenCalledWith("material_you_turned_off");
  expect(root.root.findAll((node) => node.props.testID === "materialSettingsPage" && typeof node.type === "string")).toHaveLength(0);
  expect(materialBars(root)).toHaveLength(0);
  unmount(root);
});

onIPhone("iPhone never offers Material You", () => {
  const root = renderSurface(<Surfaces />);
  act(() => openSettings());
  settle();
  expect(materialYouRow(root)).toBeUndefined();
  unmount(root);
});

onAndroid("rapid Material You flips and dismissal leave the browser in the final design", () => {
  const root = renderSurface(<Surfaces />);
  act(() => openSettings());
  settle();
  act(() => {
    usePreferences.setState({ materialYou: true });
    usePreferences.setState({ materialYou: false });
    usePreferences.setState({ materialYou: true });
    closeSettings();
  });
  settle();
  expect(materialBars(root)).toHaveLength(1);
  act(() => {
    openSettings();
    usePreferences.setState({ materialYou: false });
    closeSettings();
  });
  settle();
  expect(materialBars(root)).toHaveLength(0);
  unmount(root);
});

test("a menu portal retains its opening design through its exit", () => {
  function DesignLabel() {
    return <Text testID="portalDesign">{useDesign()}</Text>;
  }
  const root = renderSurface(<DesignProvider design="material"><Portal exitMs={200}><DesignLabel /></Portal></DesignProvider>);
  expect(root.root.findAll((node) => node.props.testID === "portalDesign")[0]!.props.children).toBe("material");
  updateSurface(root, <DesignProvider design="redesigned">{null}</DesignProvider>);
  expect(root.root.findAll((node) => node.props.testID === "portalDesign")[0]!.props.children).toBe("material");
  act(() => jest.advanceTimersByTime(400));
  expect(root.root.findAll((node) => node.props.testID === "portalDesign")).toHaveLength(0);
  unmount(root);
});

onAndroid("Material You returns TalkBack focus to the replacement switch after each flip", () => {
  const focus = jest.spyOn(coverFocus, "focusForScreenReader").mockImplementation(() => () => undefined);
  const root = renderSurface(<Surfaces />);
  act(() => openSettings());
  settle();
  focus.mockClear();
  act(() => materialYouRow(root)!.props.onPress());
  settle();
  expect(focus).toHaveBeenCalledTimes(1);
  focus.mockClear();
  act(() => materialYouRow(root)!.props.onPress());
  settle();
  expect(focus).toHaveBeenCalledTimes(1);
  unmount(root);
});

onAndroid("reopening Settings during dismissal starts a fresh scroll view at the top", () => {
  usePreferences.setState({ materialYou: true });
  const root = renderSurface(<Surfaces />);
  act(() => openSettings());
  settle();
  const settingsList = () => root.root.findAll((node) => node.props.testID === "settingsPage" && typeof node.type === "string")[0]!.findAll((node) => node.type === ScrollView)[0]!;
  const previous = settingsList();
  act(() => previous.props.onScroll({ nativeEvent: { contentOffset: { y: 240 } } }));
  expect(settingsScroll("Settings")).toBe(240);
  act(() => closeSettings());
  act(() => openSettings());
  expect(settingsList()).not.toBe(previous);
  expect(settingsList().props.contentOffset).toEqual({ x: 0, y: 0 });
  unmount(root);
});

onAndroid("a final scroll event from the exiting Settings cannot seed the newly opened page", () => {
  usePreferences.setState({ materialYou: true });
  const root = renderSurface(<Surfaces />);
  act(() => openSettings());
  settle();
  const settingsList = () => root.root.findAll((node) => node.props.testID === "settingsPage" && typeof node.type === "string")[0]!.findAll((node) => node.type === ScrollView)[0]!;
  const exitingOnScroll = settingsList().props.onScroll;
  act(() => exitingOnScroll({ nativeEvent: { contentOffset: { y: 240 } } }));
  act(() => closeSettings());
  act(() => {
    openSettings();
    exitingOnScroll({ nativeEvent: { contentOffset: { y: 265 } } });
  });
  const offset = settingsList().props.contentOffset;
  unmount(root);
  expect(offset).toEqual({ x: 0, y: 0 });
});
