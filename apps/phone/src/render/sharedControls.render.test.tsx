import { createRef } from "react";
import { Platform, PlatformColor, StyleSheet, Text, View, type ViewInstance } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { getAnimatedStyle } from "react-native-reanimated";
import { ActionButton, EmptyState, FieldAccessory, LoadingLine, LoadingState, ModalOverlay, overlayInk, press, PressInPlace, Tappable, Toggle, ToggleIconButton, ToggleRow, useTheme, type Theme } from "../components/ui";
import { renderSurface, unmount, updateSurface } from "../../test/render/harness";
import { switchColors, SYSTEM_SWITCH_COLOR_NAMES } from "../components/ui/Toggle";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrimaryButton } from "../components/ui/PrimaryButton";
import { actionRoleOf, primaryActionRoles } from "../components/ui/tokens";

const mockMotion = { reduced: false };
jest.mock("../state/app/systemLook", () => ({ ...jest.requireActual("../state/app/systemLook"), useReduceMotion: () => mockMotion.reduced }));

beforeEach(() => {
  jest.useFakeTimers();
  mockMotion.reduced = false;
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const host = (node: ReactTestInstance | undefined) => node!;

const pressableNamed = (root: ReturnType<typeof renderSurface>, label: string) => host(root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]);

const flat = (style: unknown) => StyleSheet.flatten(style as never) as Record<string, unknown>;

const pressedStyleOf = (node: ReactTestInstance, pressed: boolean) => flat(typeof node.props.style === "function" ? node.props.style({ pressed, hovered: false }) : node.props.style);

let theme: Theme;
function ThemeProbe() {
  theme = useTheme();
  return null;
}

test("a busy action keeps its spoken name, shows progress and takes no second press", () => {
  const onPress = jest.fn();
  const root = renderSurface(<ActionButton title="Try Again" onPress={onPress} busy testID="retry" />);
  const button = pressableNamed(root, "Try Again");
  expect(button.props.accessibilityRole).toBe("button");
  expect(button.props.accessibilityState).toEqual({ disabled: true, busy: true });
  expect(button.props.disabled).toBe(true);
  expect(root.root.findAll((node) => node.props.testID === "retryBusy").length).toBeGreaterThan(0);
  unmount(root);
});

test("pressing an action dims it in place: no scale, no movement", () => {
  const root = renderSurface(<ActionButton title="Continue" onPress={() => undefined} />);
  const pressed = pressedStyleOf(pressableNamed(root, "Continue"), true);
  expect(pressed.opacity).toBe(press.filledOpacity);
  expect(pressed.transform).toBeUndefined();
  expect(pressedStyleOf(pressableNamed(root, "Continue"), false).opacity).toBeUndefined();
  unmount(root);
});

test("a filled action on an always-dark overlay pairs dark ink with its white fill, whatever the app's scheme", () => {
  const root = renderSurface(<ActionButton title="Open Settings" onPress={() => undefined} tone="overlay" />);
  const button = pressableNamed(root, "Open Settings");
  expect(pressedStyleOf(button, false).backgroundColor).toBe(overlayInk.fill);
  const label = host(button.findAll((node) => node.type === Text)[0]);
  expect(flat(label.props.style).color).toBe(overlayInk.onFill);
  unmount(root);
});

test("a filled accent action draws the accent fill with on-accent ink", () => {
  const root = renderSurface(
    <>
      <ThemeProbe />
      <ActionButton title="Get Started" onPress={() => undefined} size="hero" />
    </>,
  );
  const button = pressableNamed(root, "Get Started");
  expect(pressedStyleOf(button, false).backgroundColor).toBe(theme.spaceAccent);
  expect(pressedStyleOf(button, false).borderCurve).toBe("continuous");
  const label = host(button.findAll((node) => node.type === Text)[0]);
  expect(flat(label.props.style).color).toBe(theme.onSpaceAccent);
  unmount(root);
});

test("React Native actions take their height, corner and accent fill from the named primary action roles the native adapter reads", () => {
  const root = renderSurface(
    <>
      <ThemeProbe />
      <ActionButton title="Compact" onPress={() => undefined} size="compact" />
      <ActionButton title="Full" onPress={() => undefined} />
      <PrimaryButton title="Hero" onPress={() => undefined} />
    </>,
  );
  for (const [title, role] of [["Compact", primaryActionRoles.compact], ["Full", primaryActionRoles.full], ["Hero", primaryActionRoles.hero]] as const) {
    const face = pressedStyleOf(pressableNamed(root, title), false);
    expect(face.minHeight).toBe(role.height);
    expect(face.borderRadius).toBe(role.radius);
    expect(face.backgroundColor).toBe(theme[role.fill]);
  }
  expect(actionRoleOf).toEqual({ hero: "hero", regular: "full", compact: "compact" });
  for (const file of ["ActionButton.tsx", "PrimaryButton.tsx"]) {
    const source = readFileSync(join(__dirname, "../components/ui", file), "utf8");
    expect(source).not.toMatch(/actionLayout\.(height|radius)|settingsLayout\.primaryButton/);
  }
  unmount(root);
});

test("a tappable shares the press and disabled treatment: text dims on press, disabled reads as disabled", () => {
  const root = renderSurface(
    <>
      <Tappable kind="text" label="Cancel" onPress={() => undefined}>
        <Text>Cancel</Text>
      </Tappable>
      <Tappable kind="row" label="Row" onPress={() => undefined}>
        <Text>Row</Text>
      </Tappable>
      <Tappable kind="icon" label="Off" disabled onPress={() => undefined}>
        <Text>Off</Text>
      </Tappable>
      <ThemeProbe />
    </>,
  );
  expect(pressedStyleOf(pressableNamed(root, "Cancel"), true).opacity).toBe(press.textOpacity);
  expect(pressedStyleOf(pressableNamed(root, "Row"), true).backgroundColor).toBe(theme.rowPressed);
  const off = pressableNamed(root, "Off");
  expect(off.props.accessibilityState).toEqual({ disabled: true, busy: false });
  expect(pressedStyleOf(off, false).opacity).toBe(press.disabledOpacity);
  unmount(root);
});

test("the form switch is a checked switch whose off track is the system's off fill", () => {
  const onChange = jest.fn();
  const root = renderSurface(
    <>
      <ThemeProbe />
      <Toggle label="Block Ads" value={false} onChange={onChange} />
    </>,
  );
  const control = pressableNamed(root, "Block Ads");
  expect(control.props.accessibilityRole).toBe("switch");
  expect(control.props.accessibilityState).toEqual({ checked: false, disabled: false });
  act(() => control.props.onPress());
  expect(onChange).toHaveBeenCalledWith(true);
  const track = host(root.root.findAll((node) => node.props.testID === "toggleTrack" && typeof node.type === "string")[0]);
  const onFill = host(root.root.findAll((node) => node.props.testID === "toggleTrackOn" && typeof node.type === "string")[0]);
  const colors = switchColors(theme, Platform.OS);
  expect(flat(track.props.style).backgroundColor).toEqual(colors.off);
  expect(flat(onFill.props.style).backgroundColor).toEqual(colors.on);
  expect(getAnimatedStyle(onFill).opacity).toBe(0);
  unmount(root);
});

test("switches take the platform's own switch colours where it has them, and the token pair elsewhere", () => {
  const tokens = { switchOn: "#34C759", switchOff: "rgba(120,120,128,0.16)" };
  expect(switchColors(tokens, "ios")).toEqual({ on: PlatformColor(SYSTEM_SWITCH_COLOR_NAMES.on), off: PlatformColor(SYSTEM_SWITCH_COLOR_NAMES.off) });
  expect(SYSTEM_SWITCH_COLOR_NAMES).toEqual({ on: "systemGreen", off: "secondarySystemFill" });
  expect(switchColors(tokens, "android")).toEqual({ on: tokens.switchOn, off: tokens.switchOff });
});

test("a switch row is pressable as a whole, or only at the knob when asked", () => {
  const root = renderSurface(
    <>
      <ToggleRow testID="whole" label="Night Shade" value onChange={() => undefined} />
      <ToggleRow testID="knob" press="knob" label="Desktop Site" value={false} onChange={() => undefined} />
    </>,
  );
  const whole = pressableNamed(root, "Night Shade");
  expect(whole.props.accessibilityRole).toBe("switch");
  expect(flat(whole.props.style({ pressed: false })).flexDirection).toBe("row");
  const knob = pressableNamed(root, "Desktop Site");
  expect(knob.props.accessibilityRole).toBe("switch");
  expect(flat(typeof knob.props.style === "function" ? knob.props.style({ pressed: false }) : knob.props.style)?.flexDirection).toBeUndefined();
  expect(root.root.findAll((node) => node.props.accessibilityLabel === "Desktop Site").filter((node) => typeof node.props.onPress === "function").length).toBe(1);
  unmount(root);
});

test("field accessories and toggled icons get a 44-point target around a smaller glyph", () => {
  const root = renderSurface(
    <>
      <FieldAccessory icon="xmarkCircleFill" label="Clear Text" color="#000000" onPress={() => undefined} />
      <ToggleIconButton label="Incognito" checked onChange={() => undefined}>
        <View />
      </ToggleIconButton>
      <ToggleIconButton label="Grid" role="button" checked={false} onChange={() => undefined} layout="slop" visual={24}>
        <View />
      </ToggleIconButton>
    </>,
  );
  const clear = pressedStyleOf(pressableNamed(root, "Clear Text"), false);
  expect(clear.width).toBe(44);
  expect(clear.height).toBe(44);
  const incognito = pressableNamed(root, "Incognito");
  expect(incognito.props.accessibilityRole).toBe("switch");
  expect(incognito.props.accessibilityState).toEqual({ checked: true, disabled: false });
  const grid = pressableNamed(root, "Grid");
  expect(grid.props.accessibilityState).toEqual({ selected: false, disabled: false });
  expect(grid.props.hitSlop).toEqual({ top: 10, bottom: 10, left: 10, right: 10 });
  unmount(root);
});

test("a modal overlay is modal and escapable while open, and dead to touch and hidden the moment it starts closing", () => {
  const onDismiss = jest.fn();
  const focus = createRef<ViewInstance>();
  const view = (closing: boolean) => (
    <ModalOverlay testID="overlay" open closing={closing} onDismiss={onDismiss} focus={focus}>
      <View ref={focus} />
    </ModalOverlay>
  );
  const root = renderSurface(view(false));
  const open = host(root.root.findAll((node) => node.props.testID === "overlay" && typeof node.type === "string")[0]);
  expect(open.props.accessibilityViewIsModal).toBe(true);
  expect(open.props.pointerEvents).toBe("auto");
  act(() => open.props.onAccessibilityEscape());
  expect(onDismiss).toHaveBeenCalledTimes(1);
  act(() => root.update(view(true)));
  const closing = host(root.root.findAll((node) => node.props.testID === "overlay" && typeof node.type === "string")[0]);
  expect(closing.props.pointerEvents).toBe("none");
  expect(closing.props.accessibilityElementsHidden).toBe(true);
  expect(closing.props.importantForAccessibility).toBe("no-hide-descendants");
  expect(closing.props.onAccessibilityEscape).toBeUndefined();
  expect(closing.props.accessibilityViewIsModal).toBe(false);
  unmount(root);
});

for (const reduced of [false, true]) {
  test(`a bar control answers the press in place with an immediate dim and never scales${reduced ? ", with Reduce Motion too" : ""}`, () => {
    mockMotion.reduced = reduced;
    const root = renderSurface(
      <PressInPlace label="Tabs" onPress={() => undefined}>
        <View />
      </PressInPlace>,
    );
    const control = pressableNamed(root, "Tabs");
    const down = flat(control.props.children({ pressed: true }).props.style);
    expect(down.opacity).toBe(press.iconOpacity);
    expect(down.transform).toBeUndefined();
    const up = flat(control.props.children({ pressed: false }).props.style);
    expect(up.opacity).toBeUndefined();
    expect(up.transform).toBeUndefined();
    unmount(root);
  });
}

test("a disabled bar control does not dim on contact", () => {
  const root = renderSurface(
    <PressInPlace label="Back" disabled onPress={() => undefined}>
      <View />
    </PressInPlace>,
  );
  expect(flat(pressableNamed(root, "Back").props.children({ pressed: true }).props.style).opacity).toBeUndefined();
  unmount(root);
});

const settleFocus = async () => {
  for (let step = 0; step < 4; step++) {
    await act(async () => undefined);
    act(() => jest.advanceTimersByTime(20));
  }
};

for (const exit of ["closing render", "unmount while open"] as const) {
  test(`a modal overlay hands focus back to its returnFocusTo target after a ${exit}`, async () => {
    if (Platform.OS === "android") return;
    const { AccessibilityInfo } = require("react-native") as typeof import("react-native");
    const reader = jest.spyOn(AccessibilityInfo, "isScreenReaderEnabled").mockResolvedValue(true);
    const focused = jest.spyOn(AccessibilityInfo, "setAccessibilityFocus").mockImplementation(() => undefined);
    focused.mockClear();
    const opener = 4242;
    const view = (closing: boolean) => (
      <ModalOverlay open closing={closing} onDismiss={() => undefined} returnFocusTo={() => opener as never}>
        <View />
      </ModalOverlay>
    );
    const root = renderSurface(view(false));
    await settleFocus();
    expect(focused).not.toHaveBeenCalledWith(opener);
    updateSurface(root, exit === "closing render" ? view(true) : <View />);
    await settleFocus();
    expect(focused).toHaveBeenCalledWith(opener);
    unmount(root);
    reader.mockResolvedValue(false);
    focused.mockClear();
  });
}

test("empty and loading states give a heading, a glyph and a busy announcement", () => {
  const root = renderSurface(
    <>
      <EmptyState title="No Matching Tabs" glyph="magnifyingglass" message="Try a different word." action={{ title: "Clear Search", onPress: () => undefined }} />
      <LoadingState />
    </>,
  );
  expect(root.root.findAll((node) => node.props.accessibilityRole === "header" && typeof node.type !== "string").length).toBe(1);
  const loading = host(root.root.findAll((node) => node.props.accessibilityRole === "progressbar" && typeof node.type !== "string")[0]);
  expect(loading.props.accessibilityState).toEqual({ busy: true });
  expect(loading.props.accessibilityLabel).toBe("Loading…");
  unmount(root);
});

test("the page loading line draws the readable accent ink on every layout", () => {
  const root = renderSurface(
    <>
      <ThemeProbe />
      <LoadingLine watch={() => () => undefined} />
    </>,
  );
  const line = host(root.root.findAll((node) => node.props.testID === "loadingLine" && typeof node.type !== "string")[0]);
  const bar = host(line.findAll((node) => typeof node.type !== "string" && node.props.style)[1]);
  expect(flat(bar.props.style).backgroundColor).toBe(theme.spaceAccentInk);
  unmount(root);
});

test("the glass overlay action is the shared action: glass fill, white label, the filled press, and the same busy and disabled contract", () => {
  const onPress = jest.fn();
  const root = renderSurface(
    <>
      <ActionButton title="Search" variant="glass" tone="overlay" onPress={onPress} stretch />
      <ActionButton title="Done" variant="glass" tone="overlay" onPress={onPress} busy testID="glassBusy" />
      <ActionButton title="Browse" variant="glass" tone="overlay" onPress={onPress} disabled />
    </>,
  );
  const search = pressableNamed(root, "Search");
  expect(pressedStyleOf(search, false)).toMatchObject({ backgroundColor: overlayInk.glass, alignSelf: "stretch", borderCurve: "continuous" });
  expect(pressedStyleOf(search, true).opacity).toBe(press.filledOpacity);
  expect(flat(host(search.findAll((node) => node.type === Text)[0]).props.style).color).toBe(overlayInk.label);
  const busy = pressableNamed(root, "Done");
  expect(busy.props.accessibilityState).toEqual({ disabled: true, busy: true });
  expect(root.root.findAll((node) => node.props.testID === "glassBusyBusy").length).toBeGreaterThan(0);
  expect(pressableNamed(root, "Browse").props.accessibilityState).toEqual({ disabled: true, busy: false });
  unmount(root);
});

test("a field accessory draws one glyph size whatever its slot, so Clear Text looks the same in every field", () => {
  const root = renderSurface(
    <>
      <FieldAccessory icon="xmarkCircleFill" label="Clear Search" color="#000000" onPress={() => undefined} />
      <FieldAccessory icon="xmarkCircleFill" label="Clear Tabs" color="#000000" visual={32} layout="slop" onPress={() => undefined} />
    </>,
  );
  const glyphOf = (label: string) => pressableNamed(root, label).findAll((node) => node.props.name === "xmarkCircleFill" && typeof node.props.size === "number")[0]!.props.size;
  expect(glyphOf("Clear Search")).toBe(glyphOf("Clear Tabs"));
  expect(pressedStyleOf(pressableNamed(root, "Clear Tabs"), false).width).toBe(32);
  unmount(root);
});

test("the drawn and native loading states share one contract: role, busy state, the default label and one announcement", async () => {
  const { loadingContract } = require("../components/ui/ListStates") as typeof import("../components/ui/ListStates");
  const { ListLoading } = require("../components/library/listSheet") as typeof import("../components/library/listSheet");
  const focus = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  const announced = jest.spyOn(focus, "announceForScreenReader").mockImplementation(() => undefined);
  const contract = loadingContract();
  expect(contract).toEqual({ label: "Loading…", role: "progressbar", busy: true, liveRegion: "polite", nativeTraits: ["updatesFrequently"] });
  const drawn = renderSurface(<LoadingState testID="drawnLoading" />);
  await act(async () => undefined);
  const node = host(drawn.root.findAll((inner) => inner.props.testID === "drawnLoading" && typeof inner.type === "string")[0]);
  expect(node.props).toMatchObject({ accessibilityRole: contract.role, accessibilityLabel: contract.label, accessibilityState: { busy: true }, accessibilityLiveRegion: contract.liveRegion });
  unmount(drawn);
  const native = renderSurface(<ListLoading />);
  await act(async () => undefined);
  const modifiers = native.root.findAll((inner) => typeof inner.type === "string" && Array.isArray(inner.props.modifiers)).flatMap((inner) => inner.props.modifiers as { $type: string; label?: string; traits?: string[] }[]);
  expect(modifiers).toContainEqual(expect.objectContaining({ $type: "accessibilityLabel", label: contract.label }));
  expect(modifiers).toContainEqual(expect.objectContaining({ $type: "accessibilityAddTraits", traits: contract.nativeTraits }));
  unmount(native);
  expect(announced.mock.calls.map(([text]) => text)).toEqual([contract.label, contract.label]);
  announced.mockRestore();
});

test("the loading state takes the caller's ink, as Reader needs, and its own label", async () => {
  const drawn = renderSurface(<LoadingState testID="inked" label="Loading Article…" ink={{ label: "#111111", secondary: "#222222" }} />);
  await act(async () => undefined);
  const node = host(drawn.root.findAll((inner) => inner.props.testID === "inked" && typeof inner.type === "string")[0]);
  expect(node.props.accessibilityLabel).toBe("Loading Article…");
  const words = drawn.root.findAll((inner) => typeof inner.type === "string" && inner.props.children === "Loading Article…")[0]!;
  expect(flat(words.props.style).color).toBe("#222222");
  unmount(drawn);
});

test("Settings' drawn switch row is the shared switch row, its detail read with the label and indented under the icon tile", () => {
  const { ToggleRow: SettingsToggleRow } = require("../components/settings/SettingsKit") as typeof import("../components/settings/SettingsKit");
  const onChange = jest.fn();
  const root = renderSurface(<SettingsToggleRow title="Share anonymous usage stats" icon="checkmarkShield" tint="#8E8E93" detail="Counts only." value={false} onChange={onChange} />);
  const shared = root.root.findAll((node) => node.type === ToggleRow);
  expect(shared).toHaveLength(1);
  const control = pressableNamed(root, "Share anonymous usage stats, Counts only.");
  expect(control.props.accessibilityRole).toBe("switch");
  act(() => control.props.onPress());
  expect(onChange).toHaveBeenCalledWith(true);
  expect(shared[0]!.props.detailInset).toBeGreaterThan(0);
  unmount(root);
});
