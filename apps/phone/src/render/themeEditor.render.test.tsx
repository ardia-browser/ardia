import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { startingTheme, type ProfileTheme } from "@ardia/core/src/theme.ts";
import { SettingsView } from "../components/settings/SettingsView";
import { ThemePage } from "../components/settings/ThemePage";
import { DeckLookBackdrop, DesignProvider, LookBackdrop, useTheme } from "../components/ui";
import type { Design } from "../lib/design";
import { setAppearanceDesign } from "../state/settings/appearance";
import { openSettings, popSettings, settingsNav } from "../state/settings/nav";
import { usePreferences } from "../state/settings/store";
import { useThemeDraft } from "../state/settings/themeDraft";
import { useSync } from "../state/sync/store";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";
import { status, view } from "../../test/syncFixture";

const overrides: ("light" | "dark" | null)[] = [];
jest.mock("../platform/look", () => ({ ...jest.requireActual("../platform/look"), overrideColorScheme: (scheme: "light" | "dark" | null) => overrides.push(scheme) }));

const lookModule = require("@ardia/phone-native/src/look") as typeof import("@ardia/phone-native/src/look");

type Root = ReturnType<typeof renderSurface>;

const onAndroid = Platform.OS === "android" ? test : test.skip;

const blue = startingTheme("#4691C3");

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  overrides.length = 0;
  act(() => {
    usePreferences.setState({ interfaceStyle: "matchMac", schemeChoice: "matchMac", colorChoice: null, customTheme: null });
    useThemeDraft.setState({ draft: null });
    useSync.setState((state) => ({ ...state, status: status({ isEnabled: false, phase: "off" }), view: view({ profiles: [] }) }));
    setAppearanceDesign("redesigned");
  });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
  act(() => setAppearanceDesign("original"));
});

const inDesign = (node: React.ReactNode, design: Design = "redesigned") => renderSurface(<DesignProvider design={design}>{node}</DesignProvider>);

const pressable = (root: Root, label: string) => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0];

function press(root: Root, label: string) {
  const target = pressable(root, label);
  if (!target) throw new Error(`nothing labelled ${label}`);
  act(() => target.props.onPress());
}

const stored = () => usePreferences.getState().customTheme!;

function withCustom(theme: ProfileTheme = blue) {
  act(() => usePreferences.setState({ colorChoice: "custom", customTheme: theme }));
}

function layOut(root: Root, label: string, width: number) {
  const track = root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onLayout === "function")[0]!;
  act(() => track.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 34 } } }));
}

function flush() {
  act(() => {
    jest.runAllTicks();
    jest.runOnlyPendingTimers();
  });
  act(() => jest.runOnlyPendingTimers());
}

function drag(id: string, points: { x: number; y: number }[]) {
  const [first, ...rest] = points;
  act(() => {
    fireGestureHandler(getByGestureTestId(id), [
      { state: State.BEGAN, ...first },
      { state: State.ACTIVE, ...first },
      ...rest.map((point) => ({ state: State.ACTIVE, ...point })),
      { state: State.END, ...rest[rest.length - 1] },
    ]);
  });
  flush();
}

onAndroid("Custom sits after the presets on the hand-built Appearance, starts from the Mac's starting theme for the current look and opens the Theme page", () => {
  openSettings({ page: "appearance" });
  const root = inDesign(<SettingsView />);
  const custom = root.root.findAll((node) => node.props.accessibilityRole === "radio" && typeof node.props.onPress === "function").map((node) => node.props.accessibilityLabel);
  expect(custom[custom.length - 1]).toBe("Custom");
  press(root, "Custom");
  act(() => jest.runOnlyPendingTimers());
  expect(usePreferences.getState().colorChoice).toBe("custom");
  expect(stored()).toEqual(startingTheme("#C07A98"));
  expect(settingsNav().stack.map((route) => route.page)).toEqual(["root", "appearance", "theme"]);
  const text = textOf(root);
  for (const line of ["2 of 3 colors", "Intensity", "Pass-Through Blur", "Noise", "Texture", "Grain", "Direction", "135°", "Appearance", "Match System"]) expect(text).toContain(line);
  act(() => void popSettings());
  act(() => jest.runOnlyPendingTimers());
  expect(textOf(root)).toContain("Edit Theme");
  press(root, "Blue");
  expect(usePreferences.getState().colorChoice).toBe("blue");
  expect(usePreferences.getState().customTheme).not.toBeNull();
  expect(textOf(root)).not.toContain("Edit Theme");
  unmount(root);
});

test("the Theme page adds up to three colours and removes down to one", () => {
  withCustom();
  const root = inDesign(<ThemePage />);
  press(root, "Add Color");
  expect(stored().stops.length).toBe(3);
  expect(textOf(root)).toContain("3 of 3 colors");
  expect(pressable(root, "Add Color")!.props.disabled).toBe(true);
  press(root, "Remove Color");
  press(root, "Remove Color");
  expect(stored().stops.length).toBe(1);
  expect(pressable(root, "Remove Color")!.props.disabled).toBe(true);
  unmount(root);
});

test("dragging a slider keeps the value it is let go at", () => {
  withCustom();
  const root = inDesign(<ThemePage />);
  layOut(root, "Intensity", 226);
  drag("themeTrack:Intensity", [{ x: 113, y: 10 }, { x: 153, y: 10 }]);
  expect(stored().intensity).toBeCloseTo(0.7);
  expect(useThemeDraft.getState().draft).toBeNull();
  layOut(root, "Noise", 226);
  drag("themeTrack:Noise", [{ x: 13, y: 10 }, { x: 213, y: 10 }]);
  expect(stored().grain).toBe(1);
  unmount(root);
});

test("the direction dial turns the gradient and snaps to its notches", () => {
  withCustom();
  const root = inDesign(<ThemePage />);
  drag("themeDial", [{ x: 22, y: 0 }, { x: 44, y: 22 }]);
  expect(stored().angle).toBe(90);
  expect(textOf(root)).toContain("90°");
  unmount(root);
});

test("a touch on the pad away from the knobs moves the selected colour there", () => {
  withCustom();
  const root = inDesign(<ThemePage />);
  drag("themePad", [{ x: 220, y: 116 }, { x: 225, y: 116 }]);
  const moved = stored().stops[0]!;
  expect(moved.x).toBeCloseTo(225 / 232);
  expect(moved.y).toBeCloseTo(0.5);
  expect(stored().stops[1]).toEqual(blue.stops[1]);
  unmount(root);
});

const themeLookOf = (root: Root, type: unknown) => root.root.findAll((node: ReactTestInstance) => node.type === type)[0]?.props.themeLook;

test("with Custom chosen, the start page, the deck and the theme preview get the resolved theme to draw", () => {
  jest.spyOn(lookModule, "lookIsNative").mockImplementation(() => true);
  withCustom({ ...blue, angle: 200, grain: 0.4, texture: "tweed" });
  const root = renderSurface(
    <>
      <LookBackdrop themed />
      <DeckLookBackdrop />
    </>,
  );
  const expected = { stops: blue.stops, intensity: 0.6, grain: 0.4, texture: "tweed", translucency: 1, angle: 200 };
  expect(themeLookOf(root, lookModule.ProfileBackdrop)).toEqual(expected);
  expect(themeLookOf(root, lookModule.DeckBackdrop)).toEqual(expected);
  act(() => usePreferences.setState({ colorChoice: "green" }));
  expect(themeLookOf(root, lookModule.ProfileBackdrop)).toBeNull();
  unmount(root);
});

let seenDark: boolean | null = null;

function DarkProbe() {
  seenDark = useTheme().dark;
  return null;
}

test("the custom theme's Light or Dark decides the app's, and Match System hands it back", () => {
  const root = inDesign(<DarkProbe />);
  expect(seenDark).toBe(false);
  withCustom({ ...blue, mode: "dark" });
  expect(seenDark).toBe(true);
  withCustom({ ...blue, mode: "auto" });
  expect(seenDark).toBe(false);
  expect(overrides).toEqual(["dark", null]);
  unmount(root);
});

test("Match My Mac draws the Mac's full theme, its dark look and angle included", () => {
  jest.spyOn(lookModule, "lookIsNative").mockImplementation(() => true);
  const look = { ...blue, angle: 45 };
  const dark = { ...blue, stops: [blue.stops[0]!], angle: 300 };
  const profile = { ...view().profiles[0]!, syncId: "work", theme: { colors: ["#5CD6D3", "#5C71D6"], darkColors: ["#5CD6D3"], mode: "auto" as const, look, dark } };
  act(() => useSync.setState((state) => ({ ...state, status: status({ selectedProfileId: "work" }), view: view({ profiles: [profile], selectedProfileId: "work" }) })));
  const root = renderSurface(<DeckLookBackdrop />);
  expect(themeLookOf(root, lookModule.DeckBackdrop).angle).toBe(45);
  unmount(root);
});
