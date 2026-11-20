import { StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { DeckBar } from "../components/tabs/DeckBar";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const lookModule = require("@ardia/phone-native/src/look") as typeof import("@ardia/phone-native/src/look");

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const bar = () =>
  renderSurface(
    <DeckBar
      leading={{ icon: "archivebox", label: "Archive", onPress: () => undefined }}
      plusLabel="New Tab"
      frost={{ source: "deck", variant: "bar" }}
      onPlus={() => undefined}
      onPlusMenu={() => undefined}
      onSettings={() => undefined}
    />,
  );

const symbolSizes = (root: ReturnType<typeof renderSurface>) =>
  root.root.findAll((node) => typeof node.props.name === "string" && typeof node.props.size === "number" && typeof node.type !== "string").map((node) => node.props.size as number);

test("where the system glass exists, the deck bar's three buttons are glass (circle, capsule, circle) with SwiftUI's icon sizes, and the icons let touches through to the glass", () => {
  const glass = jest.spyOn(lookModule, "glassIsNative").mockImplementation(() => true);
  const root = bar();
  const shapes = root.root.findAll((node) => node.type === lookModule.Glass).map((node) => node.props.shape);
  expect(shapes).toEqual(["circle", "capsule", "circle"]);
  expect(symbolSizes(root)).toEqual([18, 24.5, 18]);
  const glasses = root.root.findAll((node) => node.type === lookModule.Glass);
  for (const button of glasses) expect(StyleSheet.flatten(button.props.style).borderWidth).toBeUndefined();
  for (const button of glasses) expect(button.props.reduceTransparency).toBeUndefined();
  const icons = root.root.findAll((node) => typeof node.props.name === "string" && typeof node.props.size === "number" && typeof node.type !== "string");
  for (const icon of icons) expect(icon.parent?.props.pointerEvents).toBe("none");
  glass.mockRestore();
  unmount(root);
});

test("on glass each glyph takes the size that draws it as large as SwiftUI's symbol at its font size: the laptop larger than the gear", () => {
  const glass = jest.spyOn(lookModule, "glassIsNative").mockImplementation(() => true);
  const root = renderSurface(
    <DeckBar
      leading={{ icon: "laptop", label: "Synced Tabs", onPress: () => undefined }}
      plusLabel="New Tab"
      frost={{ source: "deck", variant: "bar" }}
      onPlus={() => undefined}
      onPlusMenu={() => undefined}
      onSettings={() => undefined}
    />,
  );
  expect(symbolSizes(root)).toEqual([24.6, 24.5, 18]);
  glass.mockRestore();
  unmount(root);
});

test("without the system glass the bar keeps today's frost and icon sizes", () => {
  const glass = jest.spyOn(lookModule, "glassIsNative").mockImplementation(() => false);
  const root = bar();
  expect(root.root.findAll((node) => node.type === lookModule.Glass)).toHaveLength(0);
  expect([...new Set(symbolSizes(root))].sort()).toEqual([17, 22]);
  const edges = root.root.findAll((node) => typeof node.type === "string" && StyleSheet.flatten(node.props.style)?.borderWidth === StyleSheet.hairlineWidth);
  expect(edges.length).toBeGreaterThanOrEqual(3);
  glass.mockRestore();
  unmount(root);
});
