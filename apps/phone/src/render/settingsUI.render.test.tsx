import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

type SettingsUI = typeof import("@ardia/phone-native/src/settingsUI");

const MODULE = "ArdiaPhoneSettingsUI";
const VIEWS = {
  SettingsIconTile: ["SettingsIconTileView", { systemImage: "macbook.and.iphone", tint: "sync", baseSide: 56 }],
  SettingsRowLabel: ["SettingsRowLabelView", { title: "Search Suggestions", systemImage: "text.magnifyingglass", tint: "blue" }],
  SettingsHeroContent: ["SettingsHeroContentView", { title: "Sync With Mac", subtitle: "Your Mac’s tabs here.", systemImage: "macbook.and.iphone", tint: "sync" }],
  SetupStepRow: ["SetupStepRowView", { number: 1, title: "Show the code on your Mac", detail: "On your Mac", progress: "current" }],
  ColorSwatch: ["ColorSwatchView", { preset: "blue", isSelected: true }],
  CheckmarkLabel: ["CheckmarkLabelView", { title: "Glass", isChecked: true }],
  AppIconPreview: ["AppIconPreviewView", { side: 72 }],
  SpaceTitle: ["SpaceTitleView", { name: "Work", icon: "briefcase", color: "blue", themeColors: ["#4F7CFF"], showsChevron: true }],
  SpacePageDots: ["SpacePageDotsView", { count: 4, index: 1 }],
} as const;

function load(available: boolean): SettingsUI {
  let loaded: SettingsUI | undefined;
  jest.isolateModules(() => {
    jest.doMock("expo-modules-core", () => {
      const actual = jest.requireActual("expo-modules-core");
      return { ...actual, requireOptionalNativeModule: (name: string) => (name === MODULE ? (available ? {} : null) : actual.requireOptionalNativeModule(name)) };
    });
    jest.doMock("expo", () => ({ ...jest.requireActual("expo"), requireNativeView: (_module: string, view: string) => view }));
    loaded = require("@ardia/phone-native/src/settingsUI");
  });
  return loaded!;
}

function render(element: ReturnType<typeof createElement>) {
  let root: ReactTestRenderer | undefined;
  act(() => {
    root = create(element);
  });
  return root!;
}

afterEach(() => {
  jest.dontMock("expo-modules-core");
  jest.dontMock("expo");
});

test("without the native module the settings pieces draw nothing and send no modifier", () => {
  const ui = load(false);
  expect(ui.settingsUIAvailable()).toBe(false);
  for (const [name, [, props]] of Object.entries(VIEWS)) {
    const root = render(createElement(ui[name as keyof typeof VIEWS] as never, props as never));
    expect(root.toJSON()).toBeNull();
    act(() => root.unmount());
  }
  const all = [ui.settingsChrome(), ui.settingsPage("Sync With Mac"), ui.chromeSurface({ shape: "capsule" }), ui.settingsSwitchStyle(), ui.pressableStyle(), ui.legibleInk("green"), ui.profileLook({ color: "plum" }), ui.contentMargins({ edges: "top", length: 12 }), ui.spaceBackdrop({ color: "purple" }), ui.minListRowHeight(48)];
  expect(all.every((modifier) => modifier === null)).toBe(true);
  expect(ui.modifierList(...all)).toEqual([]);
});

test("with the native module each view mounts by its native name with its props, and each modifier carries its ardia type", () => {
  const ui = load(true);
  expect(ui.settingsUIAvailable()).toBe(true);
  for (const [name, [native, props]] of Object.entries(VIEWS)) {
    const root = render(createElement(ui[name as keyof typeof VIEWS] as never, props as never));
    const mounted = root.root.findAll((node) => node.type === native)[0]!;
    expect(mounted.props).toMatchObject(props);
    act(() => root.unmount());
  }
  expect(ui.settingsChrome()).toEqual({ $type: "ardia.settingsChrome" });
  expect(ui.settingsPage("Sync With Mac")).toEqual({ $type: "ardia.settingsPage", title: "Sync With Mac" });
  expect(ui.chromeSurface({ shape: "rounded", cornerRadius: 16, interactive: false, tinted: true })).toEqual({ $type: "ardia.chromeSurface", shape: "rounded", cornerRadius: 16, interactive: false, tinted: true });
  expect(ui.settingsSwitchStyle()).toEqual({ $type: "ardia.settingsSwitchStyle" });
  expect(ui.pressableStyle()).toEqual({ $type: "ardia.pressableStyle" });
  expect(ui.legibleInk("green")).toEqual({ $type: "ardia.legibleInk", tint: "green" });
  expect(ui.profileLook({ color: "blue", themeColors: ["#4F7CFF"] })).toEqual({ $type: "ardia.profileLook", color: "blue", themeColors: ["#4F7CFF"], darkThemeColors: null, usesGlass: true });
  expect(ui.contentMargins({ edges: "top", length: 12 })).toEqual({ $type: "ardia.contentMargins", edges: "top", length: 12 });
  expect(ui.minListRowHeight(48)).toEqual({ $type: "ardia.minListRowHeight", height: 48 });
  expect(ui.spaceBackdrop({ color: "purple", themeColors: ["#7A4FFF"] })).toEqual({ $type: "ardia.spaceBackdrop", color: "purple", icon: null, themeColors: ["#7A4FFF"], themeDarkColors: null, animated: true });
  expect(ui.modifierList(ui.settingsChrome(), null, false, ui.pressableStyle()).map((modifier) => modifier.$type)).toEqual(["ardia.settingsChrome", "ardia.pressableStyle"]);
});
