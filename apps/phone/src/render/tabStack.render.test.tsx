import { StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { BottomBar, TabStack } from "../components/browsing/BottomBar";
import { FloatingTabsButton } from "../components/browsing/FloatingBar";
import { rolesFor, tabsLayout } from "../components/ui";
import { renderSurface, someTabs, unmount } from "../../test/render/harness";

const roles = rolesFor(false);
const noop = () => undefined;

type Root = ReturnType<typeof renderSurface>;
const hosts = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");
const flat = (node: { props: { style?: unknown } }) => StyleSheet.flatten(node.props.style as never) ?? {};

beforeEach(() => jest.useFakeTimers());

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

test.each([1, 2])("with %i open tabs the cards sit in one tile-sized box, so the tabs button centres them however its glyph layer is laid out", (count) => {
  const tabs = someTabs(count);
  const root = renderSurface(<TabStack tabs={tabs} roles={roles} />);
  const [stack] = hosts(root, "tabStack");
  expect(stack).toBeDefined();
  expect(flat(stack!)).toMatchObject({ width: tabsLayout.tabStackTile.width, height: tabsLayout.tabStackTile.height });
  expect(flat(stack!).position).toBeUndefined();
  const cards = hosts(root, "tabStackCard");
  expect(cards).toHaveLength(count);
  for (const card of cards) {
    expect(flat(card)).toMatchObject({ position: "absolute", width: tabsLayout.tabStackTile.width, height: tabsLayout.tabStackTile.height });
    let up = card.parent;
    while (up && typeof up.type !== "string") up = up.parent;
    expect(up).toBe(stack);
  }
  unmount(root);
});

test("one tab keeps its slight tilt and the pair's card size, so it reads as a single card rather than half a pair", () => {
  const root = renderSurface(<TabStack tabs={someTabs(1)} roles={roles} />);
  const [card] = hosts(root, "tabStackCard");
  expect(flat(card!).transform).toEqual([{ translateX: 0 }, { translateY: 0 }, { rotate: "-4deg" }]);
  unmount(root);
});

test("the redesigned tabs button holds a tile-sized stack for one tab, where it used to hang a lone card off the circle's centre", () => {
  const tabs = someTabs(1);
  const root = renderSurface(<FloatingTabsButton tab={tabs[0]!} order={tabs} roles={roles} dark={false} testID="floatingBarTabs" onTabs={noop} onTabsMenu={noop} onStep={noop} />);
  const glyphs = hosts(root, "floatingBarTabsGlyphs")[0]!;
  const [stack] = hosts(root, "tabStack");
  expect(stack).toBeDefined();
  let up = stack!.parent;
  while (up && typeof up.type !== "string") up = up.parent;
  expect(up).toBe(glyphs);
  expect(flat(hosts(root, "floatingBarTabs")[0]!)).toMatchObject({ alignItems: "center", justifyContent: "center" });
  unmount(root);
});

test("the original bar's tabs button centres the one-tab stack in its 47-point box, the same place its lone card was centred before", () => {
  const tabs = someTabs(1);
  const root = renderSurface(<BottomBar order={tabs} roles={roles} showsPlus onTabs={noop} onTabsMenu={noop} onStep={noop} onPlus={noop} onMore={noop} />);
  const [stack] = hosts(root, "tabStack");
  let box = stack!.parent;
  while (box && typeof box.type !== "string") box = box.parent;
  expect(flat(box!)).toMatchObject({ width: tabsLayout.tabStackButton, alignItems: "center", justifyContent: "center" });
  unmount(root);
});
