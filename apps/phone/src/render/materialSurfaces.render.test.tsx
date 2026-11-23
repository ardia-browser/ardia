import { Dimensions, Platform, StyleSheet, Text } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { ConfirmSheet, DesignProvider, Dialog, Menu, pointPlacer, Sheet, useTheme } from "../components/ui";
import { rolesFromScheme } from "../components/ui/materialRoles";
import { materialMenuFill, materialSheetMs } from "../components/ui/MaterialSurfaces";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { setDynamicScheme } from "../state/app/dynamicScheme";
import { currentPreferences, setPreference } from "../state/settings/store";
import { renderSurface, unmount, withMaterialYou } from "../../test/render/harness";

withMaterialYou();

const mockMotion = { reduced: false };
jest.mock("../state/app/systemLook", () => ({ ...jest.requireActual("../state/app/systemLook"), useReduceMotion: () => mockMotion.reduced }));

const onAndroid = Platform.OS === "android" ? test : test.skip;
const safeArea = require("react-native-safe-area-context") as { useSafeAreaInsets: () => { top: number; bottom: number; left: number; right: number } };

const LIGHT = SEEDED_SCHEMES.ardia.light;
const WALLPAPER = { light: { ...SEEDED_SCHEMES.orange.light, surfaceContainerLow: "#ABCDEF" }, dark: SEEDED_SCHEMES.orange.dark };

let colorWas: ReturnType<typeof currentPreferences>["colorChoice"];
let schemeWas: ReturnType<typeof currentPreferences>["schemeChoice"];

beforeEach(() => {
  jest.useFakeTimers();
  colorWas = currentPreferences().colorChoice;
  schemeWas = currentPreferences().schemeChoice;
  setPreference("colorChoice", null);
  setPreference("schemeChoice", "light");
  setDynamicScheme(null);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  setDynamicScheme(null);
  setPreference("colorChoice", colorWas);
  setPreference("schemeChoice", schemeWas);
  jest.useRealTimers();
});

const material = (node: React.ReactNode) => renderSurface(<DesignProvider design="material">{node}</DesignProvider>);
const host = (root: ReturnType<typeof renderSurface>, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string")[0];
const flat = (node: ReactTestInstance | undefined) => StyleSheet.flatten(node?.props.style) ?? {};

test("the scheme's roles follow Material's rules: text on surface, panels by container level, accents from primary, errors from error", () => {
  const roles = rolesFromScheme(LIGHT, false);
  expect(roles.label).toBe(LIGHT.onSurface);
  expect(roles.secondaryLabel).toBe(LIGHT.onSurfaceVariant);
  expect(roles.pageSurface).toBe(LIGHT.surface);
  expect(roles.panel).toBe(LIGHT.surfaceContainer);
  expect(roles.fieldFill).toBe(LIGHT.surfaceContainerHigh);
  expect(roles.formAccent).toBe(LIGHT.primary);
  expect(roles.accent).toBe(LIGHT.primary);
  expect(roles.destructive).toBe(LIGHT.error);
  expect(roles.divider).toBe(LIGHT.outlineVariant);
  expect(roles.toastFill).toBe(LIGHT.inverseSurface);
  expect(roles.toastLabel).toBe(LIGHT.inverseOnSurface);
  expect(roles.dialogScrim).toBe("rgba(0, 0, 0, 0.32)");
});

function ThemeProbe() {
  const theme = useTheme();
  return <Text testID="probe">{`${theme.label}|${theme.canvas}|${theme.formAccent}`}</Text>;
}

onAndroid("the material design's theme comes from the fallback scheme when the phone gives none, and from the wallpaper's when it does", () => {
  const root = material(<ThemeProbe />);
  const read = () => root.root.findAll((node) => node.props.testID === "probe")[0]!.props.children as string;
  expect(read()).toBe(`${LIGHT.onSurface}|${LIGHT.surface}|${LIGHT.primary}`);
  act(() => setDynamicScheme(WALLPAPER));
  expect(read()).toBe(`${WALLPAPER.light.onSurface}|${WALLPAPER.light.surface}|${WALLPAPER.light.primary}`);
  act(() => setPreference("colorChoice", "blue"));
  expect(read()).toBe(`${SEEDED_SCHEMES.blue.light.onSurface}|${SEEDED_SCHEMES.blue.light.surface}|${SEEDED_SCHEMES.blue.light.primary}`);
  unmount(root);
});

onAndroid("the classic design keeps its own colours whatever the scheme", () => {
  act(() => setDynamicScheme(WALLPAPER));
  const root = renderSurface(
    <DesignProvider design="original">
      <ThemeProbe />
    </DesignProvider>,
  );
  expect(root.root.findAll((node) => node.props.testID === "probe")[0]!.props.children).not.toContain(WALLPAPER.light.primary);
  unmount(root);
});

onAndroid("a sheet in the material design is a Material bottom sheet: drag handle, 28 dp top corners on surfaceContainerLow, the scrim at 32%, and the scrim or the handle dismisses it", () => {
  const dismissed = jest.fn();
  const root = material(
    <Sheet open onDismiss={dismissed} onHidden={() => undefined}>
      <Text>Body</Text>
    </Sheet>,
  );
  const sheet = flat(host(root, "materialSheet"));
  expect(sheet).toMatchObject({ borderTopLeftRadius: 28, borderTopRightRadius: 28, backgroundColor: LIGHT.surfaceContainerLow });
  expect(flat(host(root, "materialDragHandle")?.children[0] as ReactTestInstance)).toMatchObject({ width: 32, height: 4 });
  const scrim = root.root.findAll((node) => node.props.accessibilityLabel === "Close" && typeof node.props.onPress === "function")[0]!;
  expect(flat(scrim).backgroundColor).toBe("rgba(0, 0, 0, 0.32)");
  act(() => scrim.props.onPress());
  act(() => root.root.findAll((node) => node.props.testID === "materialDragHandle" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(dismissed).toHaveBeenCalledTimes(2);
  unmount(root);
});

onAndroid("a scheme change re-themes an open sheet", () => {
  const root = material(
    <Sheet open onDismiss={() => undefined} onHidden={() => undefined}>
      <Text>Body</Text>
    </Sheet>,
  );
  act(() => setDynamicScheme(WALLPAPER));
  expect(flat(host(root, "materialSheet")).backgroundColor).toBe("#ABCDEF");
  unmount(root);
});

onAndroid("a dialog in the material design is Material's: surfaceContainerHigh, 28 dp corners, a headline, text buttons in primary and error, and Back dismisses it", () => {
  const dismissed = jest.fn();
  const root = material(<Dialog title="Close All Tabs?" message="They stay in your Archive." onDismiss={dismissed} buttons={[{ title: "Cancel", onPress: dismissed }, { title: "Close All", destructive: true, onPress: () => undefined }]} />);
  expect(flat(host(root, "materialDialog"))).toMatchObject({ backgroundColor: LIGHT.surfaceContainerHigh, borderRadius: 28 });
  const texts = root.root.findAll((node) => node.type === Text);
  expect(flat(texts.find((node) => node.props.children === "Close All Tabs?")).fontSize).toBe(24);
  expect(flat(texts.find((node) => node.props.children === "Cancel")).color).toBe(LIGHT.primary);
  expect(flat(texts.find((node) => node.props.children === "Close All")).color).toBe(LIGHT.error);
  const button = root.root.findAll((node) => node.props.accessibilityRole === "button" && typeof node.props.onPress === "function")[0]!;
  expect(button.props.android_ripple).toMatchObject({ borderless: false });
  unmount(root);
});

onAndroid("a ConfirmSheet in the material design follows Material 3 AlertDialog: dynamic surfaceContainerHigh, 28 dp corners, elevation, headlineSmall title, primary Cancel and error destructive action", () => {
  const dismissed = jest.fn();
  const root = material(<ConfirmSheet confirmation={{ title: "Close All Tabs?", message: "They stay in your Archive.", action: "Close All", run: () => undefined }} onClose={dismissed} />);
  expect(flat(host(root, "drawnActionSheet"))).toMatchObject({ backgroundColor: LIGHT.surfaceContainerHigh, borderRadius: 28, elevation: 3 });
  const texts = root.root.findAll((node) => node.type === Text);
  expect(flat(texts.find((node) => node.props.children === "Close All Tabs?"))).toMatchObject({ fontSize: 24, color: LIGHT.onSurface });
  expect(flat(texts.find((node) => node.props.children === "Cancel")).color).toBe(LIGHT.primary);
  expect(flat(texts.find((node) => node.props.children === "Close All")).color).toBe(LIGHT.error);
  act(() => setDynamicScheme(WALLPAPER));
  expect(flat(host(root, "drawnActionSheet")).backgroundColor).toBe(WALLPAPER.light.surfaceContainerHigh);
  expect(flat(root.root.findAll((node) => node.type === Text).find((node) => node.props.children === "Cancel")).color).toBe(WALLPAPER.light.primary);
  unmount(root);
});

onAndroid("in landscape the material sheet stays inside the side insets and is at most 640 dp wide, centred", () => {
  const window = Dimensions.get("window");
  Dimensions.set({ window: { ...window, width: 852, height: 393 }, screen: { ...window, width: 852, height: 393 } });
  const insets = jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => ({ top: 0, bottom: 21, left: 59, right: 59 }));
  const root = material(
    <Sheet open onDismiss={() => undefined} onHidden={() => undefined}>
      <Text>Body</Text>
    </Sheet>,
  );
  const sheet = flat(host(root, "materialSheet"));
  expect(sheet.width).toBe(640);
  expect(sheet.left).toBe(59 + (852 - 118 - 640) / 2);
  expect(sheet.paddingBottom).toBe(21);
  unmount(root);
  insets.mockRestore();
  Dimensions.set({ window, screen: window });
});

onAndroid("with Android's Remove animations the material sheet comes and goes at once, as Compose's do; otherwise it enters in 250 ms and leaves in 150 ms", () => {
  expect(materialSheetMs(true, true)).toBe(0);
  expect(materialSheetMs(true, false)).toBe(0);
  expect(materialSheetMs(false, true)).toBe(250);
  expect(materialSheetMs(false, false)).toBe(150);
});

onAndroid("in dark, drawn menus sit on surfaceContainerHighest, a tone above the page and above the search view's surfaceContainerHigh, so a suggestion's menu stands off the search behind it; light keeps surfaceContainer", () => {
  const dark = SEEDED_SCHEMES.ardia.dark;
  expect(materialMenuFill(dark, true)).toBe(dark.surfaceContainerHighest);
  expect(materialMenuFill(dark, true)).not.toBe(dark.surfaceContainerHigh);
  expect(materialMenuFill(LIGHT, false)).toBe(LIGHT.surfaceContainer);
});

(Platform.OS === "android" ? test.each([360, 250]) : test.skip.each([360, 250]))("a wider Material submenu stays inside a %i dp screen", (screenWidth) => {
  const insets = jest.spyOn(safeArea, "useSafeAreaInsets").mockReturnValue({ top: 0, bottom: 0, left: 0, right: 0 });
  const items = [{ label: "More", children: [{ label: "A much longer submenu action label", onPress: () => undefined }] }];
  const root = material(<Menu items={items} placer={pointPlacer({ x: screenWidth - 20, y: 120 }, { width: screenWidth, height: 800 }, { top: 0, bottom: 0, left: 0, right: 0 }, 112)} onDismiss={() => undefined} />);
  const rows = root.root.findAll((node) => node.props.accessibilityLabel === "More" && typeof node.props.onPress === "function");
  act(() => rows[0]!.props.onPress());
  const panel = flat(host(root, "materialMenu"));
  expect(panel.width).toBe(Math.min(280, screenWidth - 16));
  expect(Number(panel.left) + Number(panel.width)).toBeLessThanOrEqual(screenWidth - 8);
  unmount(root);
  insets.mockRestore();
});

onAndroid("a Material submenu with nothing but dividers still shows its Back row, which returns to the first page", () => {
  const insets = jest.spyOn(safeArea, "useSafeAreaInsets").mockReturnValue({ top: 0, bottom: 0, left: 0, right: 0 });
  const items = [{ label: "More", children: ["divider" as const] }, { label: "Stay", onPress: () => undefined }];
  const root = material(<Menu items={items} placer={pointPlacer({ x: 40, y: 120 }, { width: 360, height: 800 }, { top: 0, bottom: 0, left: 0, right: 0 }, 112)} onDismiss={() => undefined} />);
  const press = (label: string) => act(() => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!.props.onPress());
  press("More");
  expect(root.root.findAll((node) => node.props.testID === "materialMenuGroup" && typeof node.type === "string")).toHaveLength(1);
  press("Back, More");
  expect(root.root.findAll((node) => node.props.accessibilityLabel === "Stay" && typeof node.props.onPress === "function").length).toBeGreaterThan(0);
  unmount(root);
  insets.mockRestore();
});

onAndroid("with reduced motion, a placed Material menu stays invisible until its rows are measured, then shows at once", () => {
  mockMotion.reduced = true;
  const insets = jest.spyOn(safeArea, "useSafeAreaInsets").mockReturnValue({ top: 0, bottom: 0, left: 0, right: 0 });
  const root = material(<Menu items={[{ label: "Stay", onPress: () => undefined }]} placer={pointPlacer({ x: 40, y: 120 }, { width: 360, height: 800 }, { top: 0, bottom: 0, left: 0, right: 0 }, 112)} onDismiss={() => undefined} />);
  const unmeasured = getAnimatedStyle(host(root, "materialMenu")!).opacity;
  act(() => root.root.findAll((node) => node.props.testID === "drawnMenuRows" && typeof node.props.onContentSizeChange === "function")[0]!.props.onContentSizeChange(200, 64));
  act(() => jest.advanceTimersByTime(32));
  const measured = getAnimatedStyle(host(root, "materialMenu")!).opacity;
  unmount(root);
  insets.mockRestore();
  mockMotion.reduced = false;
  expect(unmeasured).toBe(0);
  expect(measured).toBe(1);
});

onAndroid("a fixed trailing menu respects the right safe inset", async () => {
  const overlay = require("../components/ui/Overlay");
  const insets = jest.spyOn(safeArea, "useSafeAreaInsets").mockReturnValue({ top: 0, bottom: 0, left: 0, right: 40 });
  const frame = jest.spyOn(overlay, "useOverlayFrame").mockReturnValue(() => Promise.resolve({ x: 0, y: 0, width: 250, height: 800 }));
  const { FloatingMenu } = require("../components/ui");
  const root = material(<FloatingMenu items={[{ label: "Delete All Downloads", icon: "trash", onPress: () => undefined }]} place={{ top: 100, right: 8 }} onDismiss={() => undefined} />);
  await act(async () => {});
  const panel = flat(host(root, "materialMenu"));
  unmount(root);
  insets.mockRestore();
  frame.mockRestore();
  expect(panel.width).toBe(194);
  expect(250 - Number(panel.right)).toBeLessThanOrEqual(250 - 40 - 8);
});
