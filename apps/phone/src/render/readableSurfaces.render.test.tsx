import type { ReactNode } from "react";
import { Platform, StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { renderSurface, unmount } from "../../test/render/harness";
import { ActionButton, ChromeSurface, DesignProvider, LookFrost, LookGlass, overlayInkFor, overlayPlateFill, SURFACES_FROST, useSurfaceInk, type SurfaceInk } from "../components/ui";
import { OverlayCancelButton } from "../components/ui/LookViews";
import { IncognitoLook } from "../components/ui/theme";
import { chromeInk, overlayInk } from "../components/ui/tokens";
import { compositeOver, inkContrastOnPlate, inkContrastOverGray, plateBounds, READABLE_GLYPH, READABLE_TEXT } from "../lib/readableInk";
import { usePreferences } from "../state/settings/store";

const lookModule = require("@ardia/phone-native/src/look") as typeof import("@ardia/phone-native/src/look");

const withGlass = (glass: boolean) => {
  jest.spyOn(lookModule, "lookIsNative").mockImplementation(() => true);
  jest.spyOn(lookModule, "glassIsNative").mockImplementation(() => glass);
};

beforeEach(() => jest.useFakeTimers());

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const seen: SurfaceInk[] = [];

function Probe() {
  seen.push(useSurfaceInk());
  return null;
}

type Plate = { name: string; glass: boolean; render: (dark: boolean, incognito: boolean) => ReactNode };

const PLATES: Plate[] = [
  { name: "chrome glass", glass: true, render: (dark, incognito) => <ChromeSurface testID="plate" shape="capsule" cornerRadius={20} dark={dark} incognito={incognito}><Probe /></ChromeSurface> },
  { name: "chrome solid", glass: false, render: (dark, incognito) => <ChromeSurface testID="plate" shape="capsule" cornerRadius={20} dark={dark} incognito={incognito}><Probe /></ChromeSurface> },
  { name: "look glass", glass: true, render: (dark, incognito) => <LookGlass source={SURFACES_FROST} variant="glass" shape="capsule" cornerRadius={20} fill="rgba(255,255,255,0.14)" dark={dark} incognito={incognito}><Probe /></LookGlass> },
  { name: "deck frost", glass: false, render: (dark, incognito) => <LookFrost source={SURFACES_FROST} variant="thin" cornerRadius={20} fill={dark ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.62)"} dark={dark} incognito={incognito}><Probe /></LookFrost> },
  { name: "frost glass", glass: true, render: (dark, incognito) => <LookFrost source={SURFACES_FROST} variant="glass" cornerRadius={20} fill="rgba(255,255,255,0.18)" dark={dark} incognito={incognito}><Probe /></LookFrost> },
];

const nativePlate = (root: ReturnType<typeof renderSurface>): ReactTestInstance | null =>
  root.root.findAll((node) => node.type === lookModule.Glass || node.type === lookModule.Frost)[0] ?? null;

const backgroundOf = (node: ReactTestInstance) => StyleSheet.flatten(node.props.style)?.backgroundColor as string | undefined;

const SHADES = [
  { dark: false, incognito: false },
  { dark: true, incognito: false },
  { dark: false, incognito: true },
];

describe.each(["redesigned", "material"] as const)("in the %s design", (design) => {
  test.each(PLATES.flatMap((plate) => SHADES.map((shade) => [plate.name, plate, shade] as const)))("%s: ink comes from the shade the plate is drawn with and reads over the plate's whole luminance range (%#)", (_name, plate, shade) => {
    withGlass(plate.glass);
    seen.length = 0;
    const root = renderSurface(<DesignProvider design={design}>{plate.render(shade.dark, shade.incognito)}</DesignProvider>);
    const ink = seen.at(-1)!;
    const native = nativePlate(root);
    if (native) expect(native.props.dark).toBe(ink.dark);
    if (shade.incognito && Platform.OS === "android" && native) expect(ink.dark).toBe(true);
    expect(inkContrastOnPlate(ink.roles.label, ink.dark)).toBeGreaterThanOrEqual(READABLE_TEXT);
    expect(inkContrastOnPlate(ink.roles.toastLabel, ink.dark)).toBeGreaterThanOrEqual(READABLE_TEXT);
    expect(inkContrastOnPlate(ink.chrome.foreground, ink.dark)).toBeGreaterThanOrEqual(READABLE_TEXT);
    expect(inkContrastOnPlate(ink.roles.secondaryLabel, ink.dark)).toBeGreaterThanOrEqual(READABLE_GLYPH);
    expect(inkContrastOnPlate(ink.chrome.secondary, ink.dark)).toBeGreaterThanOrEqual(READABLE_GLYPH);
    if (native && native.type === lookModule.Frost) {
      const fill = backgroundOf(native)!;
      for (const page of ["#FFFFFF", "#000000", "#808080"]) expect(inkContrastOverGray(ink.roles.label, grayOf(compositeOver(fill, page)))).toBeGreaterThanOrEqual(READABLE_TEXT);
    }
    unmount(root);
  });
});

const grayOf = (hex: string) => {
  const value = parseInt(hex.slice(1, 3), 16) * 0.2126 + parseInt(hex.slice(3, 5), 16) * 0.7152 + parseInt(hex.slice(5, 7), 16) * 0.0722;
  return value / 255;
};

test("the plate bounds are the iPhone shader's: white ink at five to one under the ceiling, dark ink over the floor", () => {
  expect(plateBounds.ceiling).toBeGreaterThan(0.08);
  expect(plateBounds.ceiling).toBeLessThan(0.13);
  expect(plateBounds.floor).toBeGreaterThan(0.2);
  expect(plateBounds.floor).toBeLessThan(0.32);
  expect(inkContrastOverGray(chromeInk.dark.foreground, plateBounds.ceilingGray)).toBeGreaterThanOrEqual(4.99);
  expect(inkContrastOverGray(chromeInk.light.foreground, plateBounds.floorGray)).toBeGreaterThanOrEqual(4.99);
});

test("a toast in Incognito reads light ink on a dark plate, and the ink is the plate's", () => {
  withGlass(true);
  seen.length = 0;
  const root = renderSurface(
    <IncognitoLook value>
      <ChromeSurface testID="toastPlate" shape="rounded" cornerRadius={20} interactive={false} barShadow>
        <Probe />
      </ChromeSurface>
    </IncognitoLook>,
  );
  expect(nativePlate(root)!.props.dark).toBe(true);
  expect(seen.at(-1)!.dark).toBe(true);
  unmount(root);
});

describe("the overlay plate over a live camera or the voice cover", () => {
  test("keeps white ink readable over a white and a black image without frost", () => {
    for (const image of ["#FFFFFF", "#000000"]) {
      const under = compositeOver(overlayPlateFill, image);
      expect(inkContrastOverGray(overlayInk.label, grayOf(under))).toBeGreaterThanOrEqual(READABLE_TEXT);
    }
    expect(overlayInkFor().dark).toBe(true);
  });

  test("the cancel button and a glass action button draw that plate with the plate's own ink", () => {
    jest.spyOn(lookModule, "lookIsNative").mockImplementation(() => false);
    const root = renderSurface(
      <>
        <OverlayCancelButton testID="cancel" label="Cancel" onPress={() => undefined} />
        <ActionButton testID="glassAction" title="Enter Recovery Phrase" variant="glass" tone="overlay" onPress={() => undefined} />
      </>,
    );
    const plate = root.root.findAll((node) => node.props.testID === "overlayPlate" && typeof node.type === "string")[0]!;
    expect(backgroundOf(plate)).toBe(overlayPlateFill);
    const action = root.root.findAll((node) => node.props.testID === "glassAction" && typeof node.type === "string")[0]!;
    expect(StyleSheet.flatten(action.props.style).backgroundColor).toBe(overlayPlateFill);
    unmount(root);
  });
});

test("a classic chrome style still reads from its plate", () => {
  withGlass(true);
  act(() => usePreferences.setState({ interfaceStyle: "classic" } as never));
  seen.length = 0;
  const root = renderSurface(<ChromeSurface testID="plate" shape="capsule" cornerRadius={20} dark={false} incognito>
    <Probe />
  </ChromeSurface>);
  expect(nativePlate(root)!.props.dark).toBe(seen.at(-1)!.dark);
  act(() => usePreferences.setState({ interfaceStyle: "matchMac" } as never));
  unmount(root);
});
