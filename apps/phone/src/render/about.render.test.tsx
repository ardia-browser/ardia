import { Platform, StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { AboutPage, LicensesPage } from "../components/settings/DataPages";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

test("About's hero is the 72-point app icon on the icon's own cream, with a shadow and no outline, over a bold title", () => {
  const root = renderSurface(<AboutPage />);
  const icon = root.root.findAll((node) => node.props.testID === "appIcon" && typeof node.type === "string")[0]!;
  const frame = StyleSheet.flatten(icon.props.style);
  expect(frame.width).toBe(72);
  expect(frame.backgroundColor).toBe("#F8F3E1");
  expect(frame.boxShadow).toBeDefined();
  expect(icon.findAll((node) => typeof node.type === "string" && (StyleSheet.flatten(node.props.style)?.borderWidth ?? 0) > 0)).toHaveLength(0);
  expect(icon.findAll((node) => node.props.source !== undefined && typeof node.type === "string").length).toBeGreaterThan(0);
  const title = root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "header" && textOf({ root: node } as never) === "Ardia")[0]!;
  expect(StyleSheet.flatten(title.props.style).fontWeight).toBe("700");
  unmount(root);
});

test("the licences list this phone's own native code: Ardia's Swift packages on iPhone, the Android libraries on Android", () => {
  const root = renderSurface(<LicensesPage />);
  const text = textOf(root);
  if (Platform.OS === "ios") {
    expect(text).toContain("ArdiaKit and ArdiaSyncCore");
    expect(text).not.toContain("Android Jetpack");
  } else {
    expect(text).toContain("Android Jetpack");
    expect(text).not.toContain("ArdiaKit");
    expect(text).toContain("Copyright (c) 2026 Andras Prifer");
    expect(text).toContain("The above copyright notice and this permission notice shall be included");
  }
  if (Platform.OS === "ios") expect(text).not.toContain("Andras Prifer");
  unmount(root);
});
