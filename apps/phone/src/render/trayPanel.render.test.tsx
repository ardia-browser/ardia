import { StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { SearchTray } from "../components/search/SearchTray";
import { DesignProvider, MotionView } from "../components/ui";
import * as browse from "../state/browse/store";
import { dismissSearch, presentSearch } from "../state/search/store";
import { useTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const open = (design: "original" | "redesigned") => {
  act(() => presentSearch("page"));
  return renderSurface(
    <DesignProvider design={design}>
      <SearchTray />
    </DesignProvider>,
  );
};

const host = (root: ReturnType<typeof renderSurface>, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string")[0];

const departure = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.type === MotionView)[0]!;

test("in the redesign search is a floating panel: 8 points in from the sides and above the keyboard, 26-point corners, the field 9 points in, on a tinted surface over glass", () => {
  const root = open("redesigned");
  const panel = StyleSheet.flatten(host(root, "trayPanel")!.props.style);
  expect(panel).toMatchObject({ position: "absolute", left: 8, right: 8, bottom: 8, borderRadius: 26 });
  expect(panel.boxShadow).toBe("0px 4px 36px rgba(0, 0, 0, 0.1)");
  const fieldArea = root.root.findAll((node) => typeof node.type === "string" && StyleSheet.flatten(node.props.style)?.paddingTop === 9)[0];
  expect(StyleSheet.flatten(fieldArea!.props.style)).toMatchObject({ paddingHorizontal: 9, paddingTop: 9 });
  const tint = host(root, "trayPanel")!.findAll((node) => typeof node.type === "string" && StyleSheet.flatten(node.props.style)?.opacity === 0.55);
  expect(tint.length).toBeGreaterThan(0);
  unmount(root);
});

test("in the original design search is still the sheet from the bottom edge", () => {
  const root = open("original");
  expect(host(root, "trayPanel")).toBeUndefined();
  unmount(root);
});

test("in the redesign a submitted search lifts the panel 120 points and fades it over 200 ms on main's depart curve, played in the render server on iPhone, instead of dropping it with the keyboard", () => {
  const root = open("redesigned");
  act(() => jest.advanceTimersByTime(600));
  const motion = departure(root);
  expect(motion.findAll((node) => node.props.testID === "trayPanel" && typeof node.type === "string")).toHaveLength(1);
  expect(motion.props.to).toEqual({ opacity: 1, translateY: 0 });
  act(() => dismissSearch("submitted"));
  expect(departure(root).props.to).toEqual({ opacity: 0, translateY: -120 });
  expect(departure(root).props.motion).toEqual({ type: "timing", durationMs: 200, curve: [0.2, 0, 0, 1] });
  unmount(root);
});

test("in the redesign the field is white with a half-point edge, as main's searchField is, and rows have no refine arrow", () => {
  act(() => presentSearch("page", "otter"));
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const field = root.root.findAll((node) => typeof node.type === "string" && StyleSheet.flatten(node.props.style)?.borderWidth === 0.5 && StyleSheet.flatten(node.props.style)?.minHeight !== undefined)[0];
  expect(StyleSheet.flatten(field!.props.style)).toMatchObject({ backgroundColor: "#FFFFFF", borderColor: "rgba(0,0,0,0.06)" });
  expect(root.root.findAll((node) => typeof node.props.accessibilityLabel === "string" && node.props.accessibilityLabel.startsWith("Refine ") && typeof node.props.onPress === "function")).toHaveLength(0);
  unmount(root);
});

test("pressing Go starts the panel's departure from the submit itself", () => {
  jest.spyOn(browse, "submitSearch").mockImplementation(() => {
    dismissSearch("submitted");
    return true;
  });
  act(() => presentSearch("page", "otters"));
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  act(() => jest.advanceTimersByTime(600));
  const input = root.root.findAll((node) => typeof node.props.onSubmitEditing === "function" || (typeof node.props.onSubmit === "function" && node.props.testID === "completingField"))[0]!;
  act(() => (input.props.onSubmitEditing ? input.props.onSubmitEditing({ nativeEvent: { text: "otters" } }) : input.props.onSubmit("otters")));
  expect(departure(root).props.to).toEqual({ opacity: 0, translateY: -120 });
  unmount(root);
  jest.restoreAllMocks();
});

test("in Incognito the search field asks for the dark keyboard, as main's does; otherwise it leaves the keyboard to the system", () => {
  const appearance = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => typeof node.props.keyboardAppearance === "string")[0]!.props.keyboardAppearance;
  const plain = open("redesigned");
  expect(appearance(plain)).toBe("default");
  unmount(plain);
  act(() => dismissSearch());
  act(() => useTabs.setState({ incognito: true }));
  const privately = open("redesigned");
  expect(appearance(privately)).toBe("dark");
  unmount(privately);
  act(() => useTabs.setState({ incognito: false }));
});
