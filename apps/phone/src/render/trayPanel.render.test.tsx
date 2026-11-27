import { Platform, StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { SearchTray } from "../components/search/SearchTray";
import { searchFieldHeight, searchFieldRadius, searchPanel, searchPanelPlace, searchPanelPreferredHeight, searchPanelRadius } from "../components/search/searchPanelTokens";
import { DesignProvider, MotionView, shadowCss, space } from "../components/ui";
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

test("in the redesign search is Arc's panel: 8 points in from each side, sitting on the keyboard and running on under it, smooth top corners concentric with the field, 16 + 23.75 = 39.75 points, the field 16 in and 16 down", () => {
  const root = open("redesigned");
  const panel = StyleSheet.flatten(host(root, "trayPanel")!.props.style);
  expect(panel).toMatchObject({ position: "absolute", left: 8, right: 8, borderTopLeftRadius: 39.75, borderTopRightRadius: 39.75, borderCurve: "continuous" });
  expect(panel.bottom as number).toBeLessThan(0);
  expect(panel.boxShadow).toBe(shadowCss("floating", false));
  expect(StyleSheet.flatten(host(root, "searchPanelFieldRow")!.props.style)).toMatchObject({ paddingHorizontal: 16, paddingTop: 16 });
  expect(host(root, "searchPanelFace")).toBeDefined();
  unmount(root);
});

test("in the original design the fallback tray is the floating above-keyboard card the placement rule picks: inset, rounded on all four corners concentric with the field, only as tall as its rows, with the shared field geometry", () => {
  const root = open("original");
  expect(host(root, "trayPanel")).toBeUndefined();
  const fieldHeight = searchFieldHeight(1);
  const place = searchPanelPlace("aboveKeyboard", 0);
  const card = StyleSheet.flatten(host(root, "traySheet")!.props.style);
  const panelRadius = searchPanelRadius(fieldHeight);
  expect(card).toMatchObject({ position: "absolute", left: place.cardInset, right: place.cardInset, bottom: place.cardGap, borderRadius: panelRadius, borderCurve: "continuous" });
  expect(card.borderTopLeftRadius).toBeUndefined();
  expect(card.height).toBe(searchPanelPreferredHeight("aboveKeyboard", fieldHeight, 1, space.s));
  expect(StyleSheet.flatten(host(root, "trayFieldRow")!.props.style)).toMatchObject({ paddingHorizontal: searchPanel.fieldInset, paddingTop: searchPanel.fieldInset, paddingBottom: searchPanel.rowsTop });
  expect(StyleSheet.flatten(host(root, "trayFieldCapsule")!.props.style)).toMatchObject({ height: fieldHeight, borderRadius: searchFieldRadius(fieldHeight), borderCurve: "continuous" });
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

test("in the redesign the field is Arc's grey pill at the standard 47.5-point Search height and rows have no refine arrow", () => {
  act(() => presentSearch("page", "otter"));
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const field = root.root.findAll((node) => typeof node.type === "string" && StyleSheet.flatten(node.props.style)?.borderWidth === 0.5 && StyleSheet.flatten(node.props.style)?.height !== undefined)[0];
  expect(StyleSheet.flatten(field!.props.style)).toMatchObject({ backgroundColor: "rgba(118,118,128,0.17)", height: 47.5, borderRadius: 23.75, borderCurve: "continuous" });
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
