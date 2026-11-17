import { Dimensions, StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act } from "react-test-renderer";
import { SpacesView } from "../components/sync/SpacesView";
import * as nav from "../state/settings/nav";
import { useSpaceOpen } from "../state/sync/spaceOpen";
import { useSync } from "../state/sync/store";
import { status, view } from "../../test/syncFixture";
import { pressButton, renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useSpaceOpen.setState({}, true);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const withWorkSpace = (patch: (profiles: ReturnType<typeof view>["profiles"]) => ReturnType<typeof view>["profiles"] = (profiles) => profiles) => {
  const base = view();
  useSync.setState((state) => ({ ...state, status: status({ isEnabled: true, phase: "updated" }), view: { ...base, profiles: patch(base.profiles), selectedProfileId: "work", shownProfileId: "work" } }));
};

test("a pinned tab with a symbol shows the symbol, as Compose's RemoteRow, not a favicon", () => {
  withWorkSpace((profiles) =>
    profiles.map((profile) => (profile.syncId === "work" ? { ...profile, pinned: { ...profile.pinned, sections: [{ tab: { key: "p1", title: "Starred", url: "https://star.example/", icon: "star.fill" }, group: null }] } } : profile)),
  );
  const root = renderSurface(<SpacesView />);
  const symbols = root.root.findAll((node) => node.props.testID === "spaceTabIcon" && typeof node.type === "string");
  expect(symbols.length).toBeGreaterThan(0);
  expect(symbols[0]!.findAll((node) => node.props.name === "starFill").length).toBeGreaterThan(0);
  unmount(root);
});

test("a group opened in a space is still open the next time Spaces opens, for that profile", async () => {
  withWorkSpace();
  const first = renderSurface(<SpacesView />);
  expect(textOf(first)).not.toContain("Plan");
  await pressButton(first, "Launch");
  expect(textOf(first)).toContain("Plan");
  unmount(first);
  const again = renderSurface(<SpacesView />);
  expect(textOf(again)).toContain("Plan");
  unmount(again);
});

test("with sync off, the empty Spaces' Sync With Mac opens Connect, as Compose's sync setup, not Settings › Sync", async () => {
  const opened = jest.spyOn(nav, "openSettings");
  useSync.setState((state) => ({ ...state, status: status({ isEnabled: false, phase: "off" }), view: { ...view(), profiles: [] } }));
  const root = renderSurface(<SpacesView />);
  await pressButton(root, "Sync With Mac");
  expect(opened).toHaveBeenCalledWith({ page: "syncConnect" });
  unmount(root);
});

const textScale = (scale: number) => {
  const window = Dimensions.get("window");
  Dimensions.set({ window: { ...window, fontScale: scale }, screen: { ...window, fontScale: scale } });
  return () => Dimensions.set({ window, screen: window });
};

test("at large text the rows' icons and the pinned tiles grow, titles wrap to three lines, and tiles drop their titles, as Compose's Spaces", () => {
  withWorkSpace();
  const restore = textScale(1.6);
  const root = renderSurface(<SpacesView />);
  const icon = root.root.findAll((node) => node.props.testID === "spaceTabIcon" && typeof node.type === "string")[0]!;
  expect(StyleSheet.flatten(icon.props.style).width).toBeCloseTo(24 * 1.6);
  const face = root.root.findAll((node) => node.props.testID === "spaceTileFace" && typeof node.type === "string")[0]!;
  expect(StyleSheet.flatten(face.props.style).height).toBe(72);
  expect(textOf(root)).not.toContain("Mail");
  const titles = root.root.findAll((node) => typeof node.type === "string" && node.type === "Text" && node.props.numberOfLines === 3);
  expect(titles.length).toBeGreaterThan(0);
  unmount(root);
  restore();
});

test("the profile switcher scrolls when profiles overflow, rows and tiles offer their menu to screen readers, and a group's chevron turns as it opens", async () => {
  withWorkSpace();
  const root = renderSurface(<SpacesView />);
  expect(root.root.findAll((node) => node.props.testID === "spacesSwitcher" && node.props.horizontal === true).length).toBeGreaterThan(0);
  const withMenu = root.root.findAll(
    (node) => typeof node.props.onAccessibilityAction === "function" && (node.props.accessibilityActions ?? []).some((action: { name: string }) => action.name === "longpress" || action.name === "More Options"),
  );
  expect(withMenu.length).toBeGreaterThan(1);
  const disclosure = () => root.root.findAll((node) => node.props.testID === "spaceDisclosure" && typeof node.type === "string")[0]!;
  const turn = () => ((getAnimatedStyle(disclosure()).transform as { rotate?: string }[] | undefined) ?? []).map((step) => step.rotate).join("");
  expect(turn()).toBe("0deg");
  await pressButton(root, "Launch");
  act(() => jest.advanceTimersByTime(1000));
  expect(turn()).toBe("90deg");
  expect(root.root.findAll((node) => node.props.testID === "spaceRowAppearing" && typeof node.type === "string").length).toBeGreaterThan(0);
  unmount(root);
});
