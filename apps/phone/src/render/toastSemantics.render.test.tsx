import { AccessibilityInfo, Platform, StyleSheet } from "react-native";
import { ChromeSurface, chromeLayout, press } from "../components/ui";
import { act } from "react-test-renderer";
import { ToastHost } from "../components/toasts/ToastHost";
import { showToast, useToasts } from "../state/toasts/store";
import { useTabs } from "../state/tabs/store";
import { chromeInk, rolesFor } from "../components/ui";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useToasts.setState({ toast: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const toastNode = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.props.testID === "toast" && typeof node.type === "string")[0]!;
const symbols = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => typeof node.props.name === "string" && typeof node.props.size === "number" && typeof node.type !== "string").map((node) => node.props.name as string);

test("a toast without an action is an alert with no press, and swiping it away has a named screen reader action", () => {
  const root = renderSurface(<ToastHost />);
  act(() => showToast("Copied Link", "link"));
  const toast = toastNode(root);
  expect(toast.props.accessibilityRole).toBe("alert");
  expect(toast.props.onPress).toBeUndefined();
  expect(toast.props.accessibilityActions).toEqual([{ name: "dismiss", label: "Close" }]);
  expect(typeof toast.props.onAccessibilityEscape).toBe("function");
  expect(root.root.findAll((node) => node.props.testID === "toastAction")).toHaveLength(0);
  act(() => toast.props.onAccessibilityAction({ nativeEvent: { actionName: "dismiss" } }));
  expect(useToasts.getState().toast).toBeNull();
  unmount(root);
});

test("a toast with an action is a button that dims on press with the shared look, names its action in words and to screen readers, and runs it on tap", () => {
  const tapped = jest.fn();
  const root = renderSurface(<ToastHost />);
  act(() => showToast("Downloaded otter.pdf", "download", 3000, { label: "Open", run: tapped }));
  const toast = root.root.findAll((node) => node.props.testID === "toast" && typeof node.props.style === "function")[0]!;
  expect(toast.props.accessibilityRole).toBe("button");
  expect(toast.props.accessibilityLabel).toBe("Downloaded otter.pdf, Open");
  expect(toast.props.accessibilityActions).toEqual([{ name: "dismiss", label: "Close" }]);
  expect(typeof toast.props.onAccessibilityEscape).toBe("function");
  expect(root.root.findAll((node) => node.props.testID === "toastAction" && typeof node.type === "string")[0]!.props.children).toBe("Open");
  expect(symbols(root)).not.toContain("chevronRight");
  expect(StyleSheet.flatten(toast.props.style({ pressed: false })).opacity).toBeUndefined();
  expect(StyleSheet.flatten(toast.props.style({ pressed: true })).opacity).toBe(press.filledOpacity);
  act(() => toast.props.onPress());
  expect(tapped).toHaveBeenCalledTimes(1);
  expect(useToasts.getState().toast).toBeNull();
  unmount(root);
});

test("the two-finger escape dismisses a toast, actionable or not", () => {
  const root = renderSurface(<ToastHost />);
  act(() => showToast("Copied Link", "link"));
  act(() => toastNode(root).props.onAccessibilityEscape());
  expect(useToasts.getState().toast).toBeNull();
  act(() => showToast("Downloaded otter.pdf", "download", 3000, { label: "Open", run: () => undefined }));
  act(() => toastNode(root).props.onAccessibilityEscape());
  expect(useToasts.getState().toast).toBeNull();
  unmount(root);
});

test("on iPhone an actionable toast arrives as one announcement that names its action", () => {
  const announced = jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => undefined);
  announced.mockClear();
  const root = renderSurface(<ToastHost />);
  act(() => showToast("Downloaded otter.pdf", "download", 3000, { label: "Open", run: () => undefined }));
  if (Platform.OS === "ios") expect(announced.mock.calls).toEqual([["Downloaded otter.pdf, Open"]]);
  else expect(announced).not.toHaveBeenCalled();
  announced.mockRestore();
  unmount(root);
});

test("the toast's plate is the shared chrome surface, so Glass, Classic and Reduce Transparency decide it as they do the bars, with the chrome stroke", () => {
  const root = renderSurface(<ToastHost />);
  act(() => showToast("Copied Link", "link"));
  const plates = root.root.findAll((node) => node.type === ChromeSurface);
  expect(plates).toHaveLength(1);
  expect(plates[0]!.props).toMatchObject({ shape: "rounded", interactive: false });
  const drawn = root.root.findAll((node) => node.props.testID === "toastPlate" && typeof node.type === "string")[0]!;
  const face = StyleSheet.flatten(drawn.props.style);
  if (face.borderWidth !== undefined) expect(face.borderWidth).toBe(chromeLayout.edge);
  expect(StyleSheet.flatten(toastNode(root).props.style)?.backgroundColor).toBeUndefined();
  unmount(root);
});

test("Material You keeps its own snackbar plate, the inverse surface, with the named hairline stroke", () => {
  const { DesignProvider, stroke } = require("../components/ui") as typeof import("../components/ui");
  const root = renderSurface(
    <DesignProvider design="material">
      <ToastHost />
    </DesignProvider>,
  );
  act(() => showToast("Copied Link", "link"));
  expect(root.root.findAll((node) => node.type === ChromeSurface)).toHaveLength(0);
  const plate = root.root.findAll((node) => node.props.testID === "toastPlate" && typeof node.type === "string")[0]!;
  expect(StyleSheet.flatten(plate.props.style).borderWidth).toBe(stroke.hairline);
  expect(StyleSheet.flatten(plate.props.style).backgroundColor).toBeDefined();
  unmount(root);
});

test("Material You's toast reads on a wallpaper palette whose inverse text nearly matches its fill, in light and in dark", () => {
  const { DesignProvider } = require("../components/ui") as typeof import("../components/ui");
  const { setDynamicScheme } = require("../state/app/dynamicScheme") as typeof import("../state/app/dynamicScheme");
  const { SEEDED_SCHEMES } = require("../lib/material/schemes") as typeof import("../lib/material/schemes");
  const { contrastBetween } = require("../lib/color") as typeof import("../lib/color");
  const { currentPreferences, setPreference } = require("../state/settings/store") as typeof import("../state/settings/store");
  const choiceWas = currentPreferences().colorChoice;
  const schemeWas = currentPreferences().schemeChoice;
  setPreference("colorChoice", null);
  setDynamicScheme({
    light: { ...SEEDED_SCHEMES.purple.light, inverseSurface: "#131318", inverseOnSurface: "#25252F" },
    dark: { ...SEEDED_SCHEMES.purple.dark, inverseSurface: "#F5F7FF", inverseOnSurface: "#FFFFFF" },
  });
  for (const scheme of ["light", "dark"] as const) {
    setPreference("schemeChoice", scheme);
    act(() => useToasts.setState({ toast: null }));
    const root = renderSurface(
      <DesignProvider design="material">
        <ToastHost />
      </DesignProvider>,
    );
    act(() => showToast("Couldn’t Download otter.pdf", "warning"));
    const fill = StyleSheet.flatten(root.root.findAll((node) => node.props.testID === "toastPlate" && typeof node.type === "string")[0]!.props.style).backgroundColor as string;
    const ink = StyleSheet.flatten(root.root.findAll((node) => typeof node.type === "string" && node.props.children === "Couldn’t Download otter.pdf")[0]!.props.style).color as string;
    expect(contrastBetween(fill, ink)).toBeGreaterThanOrEqual(4.5);
    unmount(root);
  }
  setDynamicScheme(null);
  setPreference("colorChoice", choiceWas);
  setPreference("schemeChoice", schemeWas);
});

test("in Incognito the toast's shared plate and ink take the private look, never the profile tint, though the host sits outside the deck", () => {
  const nativeModule = require("@ardia/phone-native/src/look") as typeof import("@ardia/phone-native/src/look");
  const glass = jest.spyOn(nativeModule, "glassIsNative").mockImplementation(() => true);
  const plate = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.props.testID === "toastPlate" && node.props.source !== undefined)[0]!;
  const label = (root: ReturnType<typeof renderSurface>) => StyleSheet.flatten(root.root.findAll((node) => typeof node.type === "string" && node.props.children === "Copied Link")[0]!.props.style).color;
  const regular = renderSurface(<ToastHost />);
  act(() => showToast("Copied Link", "link"));
  expect(plate(regular).props.color).not.toBe(nativeModule.INCOGNITO_LOOK);
  unmount(regular);
  act(() => useToasts.setState({ toast: null }));
  act(() => useTabs.setState({ incognito: true }));
  const privately = renderSurface(<ToastHost />);
  act(() => showToast("Copied Link", "link"));
  expect(plate(privately).props).toMatchObject({ color: nativeModule.INCOGNITO_LOOK, dark: true });
  expect(plate(privately).props.tint).toBeUndefined();
  expect(label(privately)).toBe(rolesFor(true).toastLabel);
  expect(rolesFor(true).toastLabel).not.toBe(rolesFor(false).toastLabel);
  unmount(privately);
  glass.mockRestore();
  act(() => useToasts.setState({ toast: null }));
  act(() => useTabs.setState({ incognito: false }));
  const drawn = renderSurface(<ToastHost />);
  act(() => useTabs.setState({ incognito: true }));
  act(() => showToast("Copied Link", "link"));
  const face = drawn.root.findAll((node) => node.props.testID === "toastPlate" && typeof node.type === "string")[0]!;
  expect(StyleSheet.flatten(face.props.style).backgroundColor).toBe(chromeInk.dark.surface);
  unmount(drawn);
  act(() => useTabs.setState({ incognito: false }));
});

test("over a page the toast takes the bar's shade, so a light page in dark mode gets dark ink on a light plate, and away from the page it follows the app again", () => {
  const nativeModule = require("@ardia/phone-native/src/look") as typeof import("@ardia/phone-native/src/look");
  const { useBrowse } = require("../state/browse/store") as typeof import("../state/browse/store");
  const { notePageBarDark } = require("../state/toasts/store") as typeof import("../state/toasts/store");
  const glass = jest.spyOn(nativeModule, "glassIsNative").mockImplementation(() => true);
  const surfaceWas = useBrowse.getState().surface;
  const plate = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.props.testID === "toastPlate" && node.props.source !== undefined)[0]!;
  const label = (root: ReturnType<typeof renderSurface>) => StyleSheet.flatten(root.root.findAll((node) => typeof node.type === "string" && node.props.children === "Couldn’t Download otter.pdf")[0]!.props.style).color;
  act(() => useTabs.setState({ incognito: true }));
  act(() => useBrowse.setState({ surface: "browsing" }));
  act(() => notePageBarDark(false));
  const overPage = renderSurface(<ToastHost />);
  act(() => showToast("Couldn’t Download otter.pdf", "warning"));
  expect(plate(overPage).props.dark).toBe(false);
  expect(label(overPage)).toBe(rolesFor(false).toastLabel);
  act(() => useBrowse.setState({ surface: "deck" }));
  expect(plate(overPage).props.dark).toBe(true);
  expect(label(overPage)).toBe(rolesFor(true).toastLabel);
  unmount(overPage);
  act(() => notePageBarDark(null));
  act(() => useBrowse.setState({ surface: surfaceWas }));
  act(() => useTabs.setState({ incognito: false }));
  glass.mockRestore();
});
