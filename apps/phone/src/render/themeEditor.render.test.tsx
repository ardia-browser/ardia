import { Platform, View } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { startingTheme, type ProfileTheme } from "@ardia/core/src/theme.ts";
import { SettingsView } from "../components/settings/SettingsView";
import { ThemePage } from "../components/settings/ThemePage";
import { DeckLookBackdrop, DesignProvider, LookBackdrop, useTheme } from "../components/ui";
import type { Design } from "../lib/design";
import { setAppearanceDesign } from "../state/settings/appearance";
import { closeSettings, openSettings, popSettings, pushSettings, settingsNav } from "../state/settings/nav";
import { editCustomTheme, resetPresetTheme } from "../state/settings/customTheme";
import { usePreferences } from "../state/settings/store";
import { useThemeDraft } from "../state/settings/themeDraft";
import { useSync } from "../state/sync/store";
import { pressButton, renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";
import { status, view } from "../../test/syncFixture";

const overrides: ("light" | "dark" | null)[] = [];
const pageSchemes: ("light" | "dark" | null)[] = [];
jest.mock("../platform/look", () => ({
  ...jest.requireActual("../platform/look"),
  overrideColorScheme: (scheme: "light" | "dark" | null) => overrides.push(scheme),
  overridePageScheme: (scheme: "light" | "dark" | null) => {
    pageSchemes.push(scheme);
    return Promise.resolve(null);
  },
}));

const lookModule = require("@ardia/phone-native/src/look") as typeof import("@ardia/phone-native/src/look");

type Root = ReturnType<typeof renderSurface>;

const onAndroid = Platform.OS === "android" ? test : test.skip;
const onIos = Platform.OS === "ios" ? test : test.skip;

const blue = startingTheme("#4691C3");

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  overrides.length = 0;
  pageSchemes.length = 0;
  act(() => {
    usePreferences.setState({ interfaceStyle: "matchMac", schemeChoice: "matchMac", colorChoice: null, customTheme: null, presetThemes: {}, materialYou: false, dynamicColors: null });
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

onAndroid("picking a swatch on the hand-built Appearance applies it in place, as the Mac's theme picker does, and Edit Theme opens the editor for whatever is picked", () => {
  openSettings({ page: "appearance" });
  const root = inDesign(<SettingsView />);
  const custom = root.root.findAll((node) => node.props.accessibilityRole === "radio" && typeof node.props.onPress === "function").map((node) => node.props.accessibilityLabel);
  expect(custom[custom.length - 1]).toBe("Custom");
  expect(textOf(root)).toContain("Edit Theme");
  press(root, "Custom");
  act(() => jest.runOnlyPendingTimers());
  expect(usePreferences.getState().colorChoice).toBe("custom");
  expect(stored()).toEqual(startingTheme("#C07A98"));
  expect(settingsNav().stack.map((route) => route.page)).toEqual(["root", "appearance"]);
  press(root, "Blue");
  expect(usePreferences.getState().colorChoice).toBe("blue");
  expect(usePreferences.getState().customTheme).not.toBeNull();
  expect(settingsNav().stack.map((route) => route.page)).toEqual(["root", "appearance"]);
  press(root, "Edit Theme");
  act(() => jest.runOnlyPendingTimers());
  expect(settingsNav().stack.map((route) => route.page)).toEqual(["root", "appearance", "theme"]);
  const text = textOf(root);
  for (const line of ["2 of 3 colors", "Intensity", "Pass-Through Blur", "Noise", "Texture", "Direction", "Appearance"]) expect(text).toContain(line);
  unmount(root);
});

onAndroid("an edited preset keeps its edits on its own swatch, leaves Custom alone, and Reset brings the preset back", () => {
  withCustom();
  act(() => usePreferences.setState({ colorChoice: "green" }));
  const editor = inDesign(<ThemePage />);
  press(editor, "Add Color");
  unmount(editor);
  const edits = usePreferences.getState().presetThemes.green!;
  expect(edits.stops.length).toBe(3);
  expect(usePreferences.getState().colorChoice).toBe("green");
  expect(usePreferences.getState().customTheme).toEqual(blue);
  openSettings({ page: "appearance" });
  const root = inDesign(<SettingsView />);
  expect(pressable(root, "Green, edited")).toBeDefined();
  press(root, "Reset to Green");
  expect(usePreferences.getState().presetThemes.green).toBeUndefined();
  expect(usePreferences.getState().colorChoice).toBe("green");
  expect(textOf(root)).not.toContain("Reset to Green");
  unmount(root);
});

test("Reset on an edited preset makes the open Theme page start from the preset again, so the next edit can't bring the old edits back", () => {
  const oldEdits = { ...blue, stops: [blue.stops[0]!], grain: 0.9 };
  act(() => usePreferences.setState({ colorChoice: "green", presetThemes: { green: oldEdits } }));
  const editor = inDesign(<ThemePage />);
  expect(textOf(editor)).toContain("1 of 3 colors");
  act(() => resetPresetTheme("green"));
  expect(textOf(editor)).toContain("2 of 3 colors");
  press(editor, "Add Color");
  const saved = usePreferences.getState().presetThemes.green!;
  expect(saved.stops.length).toBe(3);
  expect(saved.grain).not.toBe(oldEdits.grain);
  unmount(editor);
});

test("leaving the Theme page while an edit is still a draft drops the draft, and the saved preset stays as it was", () => {
  act(() => usePreferences.setState({ colorChoice: "green" }));
  openSettings({ page: "appearance" });
  const root = inDesign(<SettingsView />);
  act(() => pushSettings({ page: "theme" }));
  flush();
  act(() => editCustomTheme({ ...blue, grain: 0.9 }, false));
  expect(useThemeDraft.getState().draft).not.toBeNull();
  act(() => {
    popSettings();
  });
  flush();
  expect(settingsNav().stack.map((route) => route.page)).toEqual(["root", "appearance"]);
  expect(useThemeDraft.getState().draft).toBeNull();
  expect(usePreferences.getState().presetThemes).toEqual({});
  expect(usePreferences.getState().colorChoice).toBe("green");
  unmount(root);
});

test("with no color chosen, editing the Plum the Appearance page shows edits Plum, as the Mac does, and leaves Custom alone", () => {
  withCustom();
  act(() => usePreferences.setState({ colorChoice: null }));
  const editor = inDesign(<ThemePage />);
  press(editor, "Add Color");
  expect(usePreferences.getState().colorChoice).toBe("plum");
  expect(usePreferences.getState().presetThemes.plum!.stops.length).toBe(3);
  expect(usePreferences.getState().customTheme).toEqual(blue);
  unmount(editor);
});

function matchMac(profile: Record<string, unknown>) {
  const shown = { ...view().profiles[0]!, syncId: "work", ...profile };
  act(() => useSync.setState((state) => ({ ...state, status: status({ selectedProfileId: "work" }), view: view({ profiles: [shown as never], selectedProfileId: "work" }) })));
}

const sliderValue = (root: Root, label: string) => root.root.findAll((node) => node.props.accessibilityLabel === label && node.props.accessibilityValue?.now !== undefined)[0]!.props.accessibilityValue.now;

test("while Match My Mac is on, the Theme page shows the Mac's look locked: no control writes anything, Custom and the phone's presets stay as they were", () => {
  const phoneGreen = { ...blue, grain: 0.91 };
  act(() => usePreferences.setState({ colorChoice: null, customTheme: blue, presetThemes: { green: phoneGreen } }));
  matchMac({ color: "green", theme: null });
  const editor = inDesign(<ThemePage />);
  expect(textOf(editor)).toContain("Following your Mac");
  expect(pressable(editor, "Add Color")!.props.disabled).toBe(true);
  press(editor, "Add Color");
  layOut(editor, "Noise", 226);
  drag("themeTrack:Noise", [{ x: 13, y: 10 }, { x: 213, y: 10 }]);
  expect(usePreferences.getState().colorChoice).toBeNull();
  expect(usePreferences.getState().customTheme).toEqual(blue);
  expect(usePreferences.getState().presetThemes).toEqual({ green: phoneGreen });
  expect(useThemeDraft.getState().draft).toBeNull();
  unmount(editor);
});

test("Stop matching to edit turns Match My Mac off and opens the editor, unlocked, on the look that was showing", async () => {
  act(() => usePreferences.setState({ colorChoice: null, customTheme: blue }));
  matchMac({ color: "green", theme: null });
  const editor = inDesign(<ThemePage />);
  await pressButton(editor, "Stop matching to edit");
  expect(usePreferences.getState().colorChoice).toBe("green");
  expect(usePreferences.getState().customTheme).toEqual(blue);
  expect(textOf(editor)).not.toContain("Following your Mac");
  expect(pressable(editor, "Add Color")!.props.disabled).toBe(false);
  press(editor, "Add Color");
  expect(usePreferences.getState().presetThemes.green!.stops.length).toBe(3);
  unmount(editor);
});

test("while matching the Mac, the Theme page shows the Mac's current look, also after the Mac's theme changes", () => {
  act(() => usePreferences.setState({ colorChoice: null }));
  const macTheme = (grain: number) => ({ colors: ["#5CD6D3", "#5C71D6"], darkColors: null, mode: "auto" as const, look: { ...blue, grain }, dark: null });
  matchMac({ theme: macTheme(0.15) });
  const editor = inDesign(<ThemePage />);
  expect(sliderValue(editor, "Noise")).toBe(15);
  matchMac({ theme: macTheme(0.85) });
  expect(sliderValue(editor, "Noise")).toBe(85);
  unmount(editor);
});

test("sync turning on or off while the Theme page is open re-renders it without a crash and locks or unlocks it", () => {
  act(() => usePreferences.setState({ colorChoice: null }));
  const editor = inDesign(<ThemePage />);
  expect(textOf(editor)).not.toContain("Following your Mac");
  matchMac({ color: "green", theme: null });
  expect(textOf(editor)).toContain("Following your Mac");
  act(() => useSync.setState((state) => ({ ...state, status: status({ isEnabled: false, phase: "off" }) })));
  expect(textOf(editor)).not.toContain("Following your Mac");
  unmount(editor);
});

onAndroid("with stock Green on the Mac and an edited Green on the phone, Appearance selects no swatch, since neither draws the look in use", () => {
  act(() => usePreferences.setState({ colorChoice: null, presetThemes: { green: { ...blue, grain: 0.91 } } }));
  matchMac({ color: "green", theme: null });
  openSettings({ page: "appearance" });
  const root = inDesign(<SettingsView />);
  const selected = root.root.findAll((node) => node.props.accessibilityRole === "radio" && node.props.accessibilityState?.selected === true && typeof node.props.onPress === "function").map((node) => node.props.accessibilityLabel);
  expect(selected).toEqual([]);
  act(() => usePreferences.setState({ presetThemes: {} }));
  const now = root.root.findAll((node) => node.props.accessibilityRole === "radio" && node.props.accessibilityState?.selected === true && typeof node.props.onPress === "function").map((node) => node.props.accessibilityLabel);
  expect(now).toEqual(["Green"]);
  unmount(root);
});

const iosSelectedSwatches = (root: Root) =>
  root.root
    .findAll((node) => typeof node.type === "string" && Array.isArray(node.props.modifiers) && JSON.stringify(node.props.modifiers).includes("isSelected"))
    .map((node) => JSON.stringify(node.props.modifiers).match(/"(Plum|Blue|Purple|Pink|Red|Orange|Yellow|Green|Neutral|Custom)(, edited)?"/)?.[0])
    .filter(Boolean);

onIos("on iPhone too, with stock Green on the Mac and an edited Green on the phone, Appearance selects no swatch", () => {
  act(() => usePreferences.setState({ colorChoice: null, presetThemes: { green: { ...blue, grain: 0.91 } } }));
  matchMac({ color: "green", theme: null });
  openSettings({ page: "appearance" });
  const root = renderSurface(<SettingsView />);
  expect(iosSelectedSwatches(root)).toEqual([]);
  act(() => usePreferences.setState({ presetThemes: {} }));
  expect(iosSelectedSwatches(root)).toEqual(['"Green"']);
  unmount(root);
});

test("a slider release still queued when sync turns on saves nothing: the lock is read when the edit commits, and the saved look stays as it was", () => {
  act(() => usePreferences.setState({ colorChoice: null, presetThemes: {} }));
  const editor = inDesign(<ThemePage />);
  layOut(editor, "Noise", 226);
  const track = getByGestureTestId("themeTrack:Noise");
  act(() => {
    fireGestureHandler(track, [
      { state: State.BEGAN, x: 13, y: 10 },
      { state: State.ACTIVE, x: 13, y: 10 },
      { state: State.ACTIVE, x: 200, y: 10 },
    ]);
  });
  matchMac({ color: "green", theme: null });
  expect(textOf(editor)).toContain("Following your Mac");
  act(() => {
    fireGestureHandler(track, [
      { state: State.ACTIVE, x: 200, y: 10 },
      { state: State.END, x: 200, y: 10 },
    ]);
  });
  flush();
  expect(usePreferences.getState().colorChoice).toBeNull();
  expect(usePreferences.getState().presetThemes).toEqual({});
  expect(usePreferences.getState().customTheme).toBeNull();
  expect(useThemeDraft.getState().draft).toBeNull();
  unmount(editor);
});

test("Reset while the Mac is matched leaves the phone's saved preset alone", () => {
  const phoneGreen = { ...blue, grain: 0.91 };
  act(() => usePreferences.setState({ colorChoice: null, presetThemes: { green: phoneGreen } }));
  matchMac({ color: "green", theme: null });
  act(() => resetPresetTheme("green"));
  expect(usePreferences.getState().presetThemes).toEqual({ green: phoneGreen });
});

test("the locked preview draws exactly what the app draws for the Mac's look, in the app's current light or dark", () => {
  jest.spyOn(lookModule, "lookIsNative").mockImplementation(() => true);
  const split = { colors: ["#5CD6D3", "#5C71D6"], darkColors: ["#5CD6D3"], mode: "light" as const, look: { ...blue, angle: 45, grain: 0.15 }, dark: { ...blue, angle: 300, grain: 0.85 } };
  const legacy = { colors: ["#FF6A00", "#7A3CFF"], darkColors: null };
  for (const scheme of ["dark", "light"] as const) {
    for (const theme of [split, legacy]) {
      act(() => usePreferences.setState({ colorChoice: null, schemeChoice: scheme }));
      matchMac({ theme });
      const root = inDesign(
        <>
          <ThemePage />
          <View testID="appBackdrop">
            <LookBackdrop themed />
          </View>
        </>,
      );
      const drawnIn = (testID: string) => {
        const node = root.root.findAll((inner) => inner.props.testID === testID)[0]!.findAll((inner) => inner.type === lookModule.ProfileBackdrop)[0]!;
        return { themeColors: node.props.themeColors, darkThemeColors: node.props.darkThemeColors, themeLook: node.props.themeLook, dark: node.props.dark };
      };
      const drawn = [drawnIn("themePreview"), drawnIn("appBackdrop")];
      expect(`${scheme} ${theme === split ? "split" : "legacy"}: ${JSON.stringify(drawn[0])}`).toBe(`${scheme} ${theme === split ? "split" : "legacy"}: ${JSON.stringify(drawn[1])}`);
      if (theme === split) expect(sliderValue(root, "Noise")).toBe(Math.round(drawn[1]!.themeLook.grain * 100));
      unmount(root);
    }
  }
});

onAndroid("with Custom picked and Material You on without Dynamic Colors, the colour row selects Plum, the seed the palette uses", () => {
  act(() => usePreferences.setState({ colorChoice: "custom", customTheme: blue, materialYou: true, dynamicColors: false }));
  openSettings({ page: "appearance" });
  const root = inDesign(<SettingsView />, "material");
  const swatchNames = new Set(["Plum", "Blue", "Purple", "Pink", "Red", "Orange", "Yellow", "Green", "Neutral", "Custom"]);
  const selected = root.root.findAll((node) => node.props.accessibilityRole === "radio" && node.props.accessibilityState?.selected === true && typeof node.props.onPress === "function" && swatchNames.has(node.props.accessibilityLabel)).map((node) => node.props.accessibilityLabel);
  expect(selected).toEqual(["Plum"]);
  unmount(root);
});

test("Stop matching to edit never overwrites a saved Custom: with one saved, it opens the editor on the phone's own Custom", async () => {
  const phoneCustom = { ...blue, grain: 0.91 };
  act(() => usePreferences.setState({ colorChoice: null, customTheme: phoneCustom }));
  matchMac({ theme: { colors: ["#FF6A00", "#7A3CFF"], darkColors: null, mode: "auto" as const, look: { ...blue, angle: 200, grain: 0.3 }, dark: null } });
  const editor = inDesign(<ThemePage />);
  await pressButton(editor, "Stop matching to edit");
  expect(usePreferences.getState().colorChoice).toBe("custom");
  expect(usePreferences.getState().customTheme).toEqual(phoneCustom);
  expect(pressable(editor, "Add Color")!.props.disabled).toBe(false);
  expect(sliderValue(editor, "Noise")).toBe(91);
  unmount(editor);
});

test("Stop matching to edit with no saved Custom copies the Mac's full theme into Custom, so there is something to edit", async () => {
  act(() => usePreferences.setState({ colorChoice: null, customTheme: null }));
  matchMac({ theme: { colors: ["#FF6A00", "#7A3CFF"], darkColors: null, mode: "auto" as const, look: { ...blue, angle: 200, grain: 0.3 }, dark: null } });
  const editor = inDesign(<ThemePage />);
  await pressButton(editor, "Stop matching to edit");
  expect(usePreferences.getState().colorChoice).toBe("custom");
  expect(stored().grain).toBe(0.3);
  expect(sliderValue(editor, "Noise")).toBe(30);
  unmount(editor);
});

onAndroid("a slider release still queued when Settings closes saves nothing, though the page stays drawn while it leaves", () => {
  const edited = { ...blue, grain: 0.2 };
  act(() => usePreferences.setState({ colorChoice: "green", presetThemes: { green: edited } }));
  openSettings({ page: "theme" });
  const root = inDesign(<SettingsView />);
  layOut(root, "Noise", 226);
  const track = getByGestureTestId("themeTrack:Noise");
  act(() => {
    fireGestureHandler(track, [
      { state: State.BEGAN, x: 13, y: 10 },
      { state: State.ACTIVE, x: 13, y: 10 },
      { state: State.ACTIVE, x: 200, y: 10 },
    ]);
  });
  act(() => closeSettings());
  act(() => {
    fireGestureHandler(track, [
      { state: State.ACTIVE, x: 200, y: 10 },
      { state: State.END, x: 200, y: 10 },
    ]);
  });
  flush();
  expect(usePreferences.getState().presetThemes).toEqual({ green: edited });
  expect(useThemeDraft.getState().draft).toBeNull();
  unmount(root);
});

test("a slider drag the system cancels saves nothing and leaves no draft", () => {
  act(() => usePreferences.setState({ colorChoice: "green" }));
  const editor = inDesign(<ThemePage />);
  layOut(editor, "Noise", 226);
  act(() => {
    fireGestureHandler(getByGestureTestId("themeTrack:Noise"), [
      { state: State.BEGAN, x: 13, y: 10 },
      { state: State.ACTIVE, x: 13, y: 10 },
      { state: State.ACTIVE, x: 213, y: 10 },
      { state: State.CANCELLED, x: 213, y: 10 },
    ]);
  });
  flush();
  expect(usePreferences.getState().presetThemes).toEqual({});
  expect(useThemeDraft.getState().draft).toBeNull();
  unmount(editor);
});

test("a pad or dial drag the system cancels saves nothing and leaves no draft", () => {
  act(() => usePreferences.setState({ colorChoice: "green" }));
  const editor = inDesign(<ThemePage />);
  for (const id of ["themePad", "themeDial"]) {
    act(() => {
      fireGestureHandler(getByGestureTestId(id), [
        { state: State.BEGAN, x: 20, y: 20 },
        { state: State.ACTIVE, x: 20, y: 20 },
        { state: State.ACTIVE, x: 40, y: 30 },
        { state: State.CANCELLED, x: 40, y: 30 },
      ]);
    });
    flush();
    expect(`${id}: ${JSON.stringify(usePreferences.getState().presetThemes)}`).toBe(`${id}: {}`);
    expect(useThemeDraft.getState().draft).toBeNull();
  }
  unmount(editor);
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

test("a custom theme's Light colours the app but pages keep the system's scheme, and the user's Dark reaches pages", () => {
  const root = inDesign(<DarkProbe />);
  withCustom({ ...blue, mode: "light" });
  expect(overrides).toEqual(["light"]);
  expect(pageSchemes.filter((scheme) => scheme !== null)).toEqual([]);
  act(() => usePreferences.setState({ schemeChoice: "dark" }));
  expect(pageSchemes.at(-1)).toBe("dark");
  act(() => usePreferences.setState({ schemeChoice: "system" }));
  expect(pageSchemes.at(-1)).toBeNull();
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
