import { Platform, StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { SettingsView } from "../components/settings/SettingsView";
import { ChromeSurface, chromeInk, DesignProvider, useTheme } from "../components/ui";
import type { Design } from "../lib/design";
import { setAppearanceDesign } from "../state/settings/appearance";
import { openSettings, pushSettings } from "../state/settings/nav";
import { usePreferences } from "../state/settings/store";
import { OFF_STATUS, useSync } from "../state/sync/store";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

const mockSystem = { reduceTransparency: false };
jest.mock("../state/app/systemLook", () => ({ ...jest.requireActual("../state/app/systemLook"), useReduceTransparency: () => mockSystem.reduceTransparency }));

const overrides: ("light" | "dark" | null)[] = [];
jest.mock("../platform/look", () => ({ ...jest.requireActual("../platform/look"), overrideColorScheme: (scheme: "light" | "dark" | null) => overrides.push(scheme) }));

const lookModule = require("@ardia/phone-native/src/look") as typeof import("@ardia/phone-native/src/look");

type Root = ReturnType<typeof renderSurface>;
type MacLook = { interfaceStyle: "glass" | "classic" | null; appearance: "auto" | "light" | "dark" | null };

function withSync(look: MacLook | null, enabled = true) {
  act(() =>
    useSync.setState((state) => ({
      ...state,
      status: { ...OFF_STATUS, isEnabled: enabled, phase: enabled ? "updated" : "off" },
      view: { devices: [], profiles: [], search: null, look, syncedAt: enabled ? 1 : null, selectedProfileId: null, receivers: [] },
    })),
  );
}

function useDesignFor(design: Design) {
  act(() => setAppearanceDesign(design));
}

const onAndroid = Platform.OS === "android" ? test : test.skip;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  mockSystem.reduceTransparency = false;
  usePreferences.setState({ interfaceStyle: "matchMac", schemeChoice: "matchMac", colorChoice: null });
  withSync(null, false);
  useDesignFor("redesigned");
  overrides.length = 0;
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
  useDesignFor("original");
});

const settings = (design: Design) =>
  renderSurface(
    <DesignProvider design={design}>
      <SettingsView />
    </DesignProvider>,
  );

const pressable = (root: Root, label: string) => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0];

function press(root: Root, label: string) {
  const target = pressable(root, label);
  if (!target) throw new Error(`nothing labelled ${label}`);
  act(() => target.props.onPress());
}

const checked = (root: Root, label: string) => pressable(root, label)!.props.accessibilityState?.selected === true;

let seenDark: boolean | null = null;

function ThemeProbe() {
  seenDark = useTheme().dark;
  return null;
}

const surfaces = () =>
  renderSurface(
    <>
      <ThemeProbe />
      <ChromeSurface testID="probeSurface" shape="capsule" cornerRadius={22} />
    </>,
  );

const glassOf = (root: Root) => root.root.findAll((node) => node.type === lookModule.Glass)[0];

function frostUnder(glass: ReactTestInstance) {
  return glass.findAll((node) => node.type === lookModule.Frost)[0];
}

onAndroid("the original Settings keeps Compose's colour row and has no Appearance row", () => {
  openSettings();
  const root = settings("original");
  expect(pressable(root, "Appearance")).toBeUndefined();
  expect(textOf(root)).toContain("Color");
  expect(root.root.findAll((node) => node.props.testID === "swatchRing" && typeof node.type === "string").length).toBe(10);
  unmount(root);
});

onAndroid("the hand-built redesigned Settings, which Android keeps until its turn, has main's Appearance row, summarised as Match My Mac until something is chosen, in place of the colour row", () => {
  openSettings();
  const root = settings("redesigned");
  const row = pressable(root, "Appearance")!;
  expect(row.props.accessibilityValue).toEqual({ text: "Match My Mac" });
  expect(root.root.findAll((node) => node.props.testID === "swatchRing" && typeof node.type === "string").length).toBe(0);
  act(() => usePreferences.setState({ colorChoice: "blue", interfaceStyle: "classic", schemeChoice: "dark" }));
  expect(pressable(root, "Appearance")!.props.accessibilityValue).toEqual({ text: "Blue, Classic, Dark" });
  press(root, "Appearance");
  act(() => jest.runOnlyPendingTimers());
  expect(textOf(root)).toContain("Interface Style");
  unmount(root);
});

onAndroid("on the hand-built Appearance Android keeps, the page has main's choices: Color, Interface Style (Match My Mac, Glass, Classic), Light or Dark (Match My Mac, System, Light, Dark) and Tabs (Stack, Grid), with main's footers", () => {
  openSettings({ page: "appearance" });
  const root = settings("redesigned");
  const text = textOf(root);
  if (Platform.OS === "android") expect(text).toContain("Appearance");
  for (const line of ["Color", "Interface Style", "Light or Dark", "Glass", "Classic", "System", "Light", "Dark"]) expect(text).toContain(line);
  expect(text).toContain("Match My Mac follows your Mac.");
  expect(text).not.toContain("Reduce Transparency");
  expect(text).toContain("Match My Mac follows your Mac. System follows this device.");
  const choices = root.root.findAll((node) => node.props.accessibilityRole === "button" && node.props.accessibilityState?.selected !== undefined && typeof node.props.onPress === "function").map((node) => node.props.accessibilityLabel);
  expect(choices).toEqual(["Match My Mac", "Glass", "Classic", "Match My Mac", "System", "Light", "Dark", "Stack", "Grid"]);
  expect(text).toContain("How your open tabs are laid out.");
  expect(root.root.findAll((node) => node.props.testID === "swatchRing" && typeof node.type === "string").length).toBe(10);
  expect(root.root.findAll((node) => node.props.accessibilityRole === "switch" && node.props.accessibilityLabel === "Match My Mac").length).toBe(0);
  unmount(root);
  withSync(null);
  const synced = settings("redesigned");
  expect(synced.root.findAll((node) => node.props.accessibilityRole === "switch" && node.props.accessibilityLabel === "Match My Mac" && typeof node.props.onPress === "function").length).toBe(1);
  unmount(synced);
});

onAndroid("on the hand-built Appearance Android keeps, choosing on the page checks the row and keeps the choice in the settings store", () => {
  openSettings({ page: "appearance" });
  const root = settings("redesigned");
  const styleRows = () => root.root.findAll((node) => node.props.accessibilityRole === "button" && node.props.accessibilityState?.selected !== undefined && typeof node.props.onPress === "function").slice(0, 3);
  expect(styleRows().map((node) => node.props.accessibilityState.selected)).toEqual([true, false, false]);
  press(root, "Classic");
  expect(usePreferences.getState().interfaceStyle).toBe("classic");
  expect(styleRows().map((node) => node.props.accessibilityState.selected)).toEqual([false, false, true]);
  press(root, "Dark");
  expect(usePreferences.getState().schemeChoice).toBe("dark");
  expect(checked(root, "Dark")).toBe(true);
  unmount(root);
});

test("choosing Classic makes every chrome surface Classic: the system glass is asked for surface classic, and Glass brings it back", () => {
  jest.spyOn(lookModule, "glassIsNative").mockImplementation(() => true);
  const root = surfaces();
  expect(glassOf(root)!.props.surface).toBe("glass");
  expect(frostUnder(glassOf(root)!)!.props.reduceTransparency).toBeUndefined();
  act(() => usePreferences.setState({ interfaceStyle: "classic" }));
  expect(glassOf(root)!.props.surface).toBe("classic");
  expect(frostUnder(glassOf(root)!)!.props.reduceTransparency).toBe(true);
  act(() => usePreferences.setState({ interfaceStyle: "glass" }));
  expect(glassOf(root)!.props.surface).toBe("glass");
  unmount(root);
});

test("without the system glass the surface draws its own Classic fill whatever the choice", () => {
  act(() => usePreferences.setState({ interfaceStyle: "classic" }));
  const root = surfaces();
  expect(glassOf(root)).toBeUndefined();
  const drawn = root.root.findAll((node) => node.props.testID === "probeSurface" && typeof node.type === "string")[0]!;
  expect(StyleSheet.flatten(drawn.props.style).backgroundColor).toBe(chromeInk.light.surface);
  unmount(root);
});

test("Reduce Transparency forces Classic even when Glass is chosen", () => {
  jest.spyOn(lookModule, "glassIsNative").mockImplementation(() => true);
  act(() => usePreferences.setState({ interfaceStyle: "glass" }));
  mockSystem.reduceTransparency = true;
  const root = surfaces();
  expect(glassOf(root)!.props.surface).toBe("classic");
  unmount(root);
});

test("choosing Dark makes the theme dark and asks the window for dark; Light makes it light; System hands it back to the device", () => {
  const root = surfaces();
  expect(seenDark).toBe(false);
  act(() => usePreferences.setState({ schemeChoice: "dark" }));
  expect(seenDark).toBe(true);
  act(() => usePreferences.setState({ schemeChoice: "light" }));
  expect(seenDark).toBe(false);
  const system = jest.spyOn(require("react-native"), "useColorScheme").mockReturnValue("dark");
  act(() => usePreferences.setState({ schemeChoice: "system" }));
  expect(seenDark).toBe(true);
  system.mockRestore();
  expect(overrides).toEqual(["dark", "light", null]);
  unmount(root);
});

test("Match My Mac follows the synced look: the Mac's Classic and Dark, then its Glass and Light, and the device again when sync is off", () => {
  jest.spyOn(lookModule, "glassIsNative").mockImplementation(() => true);
  const root = surfaces();
  withSync({ interfaceStyle: "classic", appearance: "dark" });
  expect(glassOf(root)!.props.surface).toBe("classic");
  expect(seenDark).toBe(true);
  expect(glassOf(root)!.props.dark).toBe(true);
  withSync({ interfaceStyle: "glass", appearance: "light" });
  expect(glassOf(root)!.props.surface).toBe("glass");
  expect(seenDark).toBe(false);
  withSync({ interfaceStyle: "classic", appearance: "auto" });
  expect(glassOf(root)!.props.surface).toBe("classic");
  expect(seenDark).toBe(false);
  withSync({ interfaceStyle: "classic", appearance: "dark" }, false);
  expect(glassOf(root)!.props.surface).toBe("glass");
  expect(seenDark).toBe(false);
  expect(overrides).toEqual(["dark", "light", null]);
  act(() => usePreferences.setState({ interfaceStyle: "glass", schemeChoice: "light" }));
  withSync({ interfaceStyle: "classic", appearance: "dark" });
  expect(glassOf(root)!.props.surface).toBe("glass");
  expect(seenDark).toBe(false);
  unmount(root);
});

test("in the original design neither choice applies and the window is never overridden", () => {
  useDesignFor("original");
  jest.spyOn(lookModule, "glassIsNative").mockImplementation(() => true);
  act(() => usePreferences.setState({ interfaceStyle: "classic", schemeChoice: "dark" }));
  withSync({ interfaceStyle: "classic", appearance: "dark" });
  mockSystem.reduceTransparency = true;
  const root = surfaces();
  expect(glassOf(root)!.props.surface).toBe("glass");
  expect(seenDark).toBe(false);
  expect(overrides).toEqual([]);
  unmount(root);
});
