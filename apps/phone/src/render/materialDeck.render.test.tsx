import { Keyboard, Platform, StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { cardMenuItems } from "../components/tabs/DeckCard";
import { deckOpeningScroll, TabDeck } from "../components/tabs/TabDeck";
import { deckHeaderBottom } from "../components/tabs/DeckHeader";
import { fitsMaterialChrome, MATERIAL_DECK, materialCloseCenter, materialCloseHit, materialDeckGeometry, materialOnScreen } from "../components/tabs/MaterialDeckLayout";
import { getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { deckGeometry, openingDeckScroll } from "../lib/deckGeometry";
import { DesignProvider } from "../components/ui";
import { IncognitoEyes } from "../components/ui/IncognitoEyes";
import { MenuTrigger } from "../components/ui/MenuTrigger";
import { materialKeyboardLift } from "../components/tabs/MaterialDeckChrome";
import type { Design } from "../lib/design";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { setDynamicScheme } from "../state/app/dynamicScheme";
import { haptics } from "../state/app/haptics";
import { useArchiveCard } from "../state/browse/archiveCard";
import * as browse from "../state/browse/store";
import { currentPreferences, setPreference } from "../state/settings/store";
import { OFF_STATUS, useSync } from "../state/sync/store";
import * as telemetry from "../state/telemetry/telemetry";
import { useTabs } from "../state/tabs/store";
import { renderSurface, someTabs, unmount, withTabs, withMaterialYou } from "../../test/render/harness";

withMaterialYou();

const onAndroid = Platform.OS === "android" ? test : test.skip;

const LIGHT = SEEDED_SCHEMES.ardia.light;
const DARK = SEEDED_SCHEMES.ardia.dark;
const WALLPAPER = { light: { ...SEEDED_SCHEMES.orange.light, surfaceContainerLow: "#ABCDEF" }, dark: { ...SEEDED_SCHEMES.orange.dark, surfaceContainerHighest: "#123456" } };
const SAFE = { top: 40, bottom: 24 };

let colorWas: ReturnType<typeof currentPreferences>["colorChoice"];
let schemeWas: ReturnType<typeof currentPreferences>["schemeChoice"];

beforeEach(() => {
  jest.useFakeTimers();
  colorWas = currentPreferences().colorChoice;
  schemeWas = currentPreferences().schemeChoice;
  setPreference("colorChoice", null);
  setPreference("schemeChoice", "light");
  setDynamicScheme(null);
  withTabs(4);
  useArchiveCard.setState({ showing: false });
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  useSync.setState((state) => ({ ...state, status: OFF_STATUS, view: { devices: [], profiles: [], search: null, syncedAt: null, selectedProfileId: null, receivers: [] } }));
  jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  jest.spyOn(haptics, "barPress").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  setDynamicScheme(null);
  setPreference("colorChoice", colorWas);
  setPreference("schemeChoice", schemeWas);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const deck = (design: Design = "material") =>
  renderSurface(
    <DesignProvider design={design}>
      <TabDeck />
    </DesignProvider>,
  );

const hosts = (root: Root, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
const host = (root: Root, id: string) => hosts(root, id)[0];
const pressable = (root: Root, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.props.onPress === "function" && node.props.android_ripple !== undefined)[0];
const flat = (node: ReactTestInstance | undefined) => (StyleSheet.flatten(node?.props.style) ?? {}) as Record<string, unknown>;
const cards = (root: Root) => hosts(root, "deckCard");
const withPrivates = (count: number, incognito = false) => act(() => useTabs.setState((state) => ({ ...state, privates: someTabs(count, true), incognito })));

onAndroid("the material deck's cards are elevated Material cards: surfaceContainerLow under the page, a 16 dp large shape at rest, titles in labelLarge on onSurface", () => {
  const root = deck();
  expect(cards(root).length).toBe(4);
  for (const card of cards(root)) {
    const style = flat(card);
    expect(style.backgroundColor).toBe(LIGHT.surfaceContainerLow);
    expect(style.overflow).toBe("hidden");
    expect(style.elevation).toBeGreaterThan(0);
    expect(getAnimatedStyle(card).borderRadius).toBeCloseTo(16, 5);
  }
  const titles = hosts(root, "deckHeaderTitle");
  expect(titles.length).toBe(4);
  for (const title of titles) expect(flat(title)).toMatchObject({ fontSize: 14, lineHeight: 20, fontWeight: "500", color: LIGHT.onSurface });
  unmount(root);
});

const tapDeckAt = (x: number, y: number) => {
  const tap = getByGestureTestId("deckTap") as unknown as { handlers: { onTouchesDown: (event: unknown, manager: unknown) => void; onTouchesUp: (event: unknown, manager: unknown) => void } };
  const manager = { fail: () => undefined, activate: () => undefined, end: () => undefined, begin: () => undefined };
  const touch = { id: 0, x, y, absoluteX: x, absoluteY: y };
  act(() => {
    tap.handlers.onTouchesDown({ allTouches: [touch], changedTouches: [touch] }, manager);
    tap.handlers.onTouchesUp({ allTouches: [touch], changedTouches: [touch] }, manager);
  });
};

onAndroid("each card's close is a 48 dp mark at the end of its title row, and a tap on it, taken by the deck's own tap gesture, closes that tab, counts card_close_tapped and gives the press haptic", () => {
  const closed = jest.spyOn(browse, "closeTabFromDeck").mockImplementation(() => undefined);
  const counted = jest.spyOn(telemetry, "countUsage");
  const root = deck();
  const close = hosts(root, "materialCardClose").at(-1)!;
  expect(flat(close)).toMatchObject({ width: 48, height: 48 });
  expect(close.props.pointerEvents).toBe("none");
  const g = materialDeckGeometry(393, 873, SAFE.top, SAFE.bottom, 0, "android", deckHeaderBottom(), 55);
  const relatives = [0, 1, -1].map((relative) => ({ relative, ...materialCloseCenter(g, relative, relative === 1) })).filter((spot) => spot.visible >= MATERIAL_DECK.closeShownFrom);
  expect(relatives.length).toBeGreaterThan(0);
  const spot = relatives[0]!;
  tapDeckAt(spot.x, spot.y);
  act(() => jest.advanceTimersByTime(1000));
  expect(closed).toHaveBeenCalledTimes(1);
  expect(counted).toHaveBeenCalledWith("card_close_tapped");
  expect(haptics.barPress).toHaveBeenCalled();
  unmount(root);
});

onAndroid("the × and title stop at the screen's edge on a card that runs off it, so a peeking last card never shows a cut-off ×", () => {
  const g = materialDeckGeometry(393, 873, SAFE.top, SAFE.bottom, 0, "android", deckHeaderBottom(), 55);
  const peeking = materialCloseCenter(g, 1, true);
  expect(peeking.x + 24).toBeLessThanOrEqual(g.width - MATERIAL_DECK.edge);
  expect(materialOnScreen(g, g.width - 100, 300)).toBe(100 - MATERIAL_DECK.edge);
});

test("card menus carry icons only in the material design, so the iPhone's menu is unchanged", () => {
  const tab = useTabs.getState().open[0]!;
  const context = { devices: [], pinned: false, syncEnabled: false, spaces: [] };
  const labelled = (items: ReturnType<typeof cardMenuItems>) => items.flatMap((item) => (item === "divider" || "heading" in item ? [] : [[item.label, "icon" in item ? item.icon : undefined]]));
  expect(labelled(cardMenuItems(tab, context, () => undefined))).toEqual([["Copy Link", undefined], ["Share", undefined], ["Close Tab", undefined]]);
  expect(labelled(cardMenuItems(tab, { ...context, icons: true }, () => undefined))).toEqual([["Copy Link", "link"], ["Share", "squareAndArrowUp"], ["Close Tab", "xmark"]]);
});

onAndroid("a tap in a card's close zone never opens the card: the zone sits on the title row's trailing end, 48 dp square, and only on cards wide enough to show the button", () => {
  const g = materialDeckGeometry(393, 873, SAFE.top, SAFE.bottom, 0, "android", deckHeaderBottom(), 55);
  const close = materialCloseCenter(g, 1, true);
  expect(materialCloseHit(g, 1, true, close.x, close.y + 20)).toBe(true);
  expect(materialCloseHit(g, 1, true, close.x, g.cardCenterY)).toBe(false);
  expect(materialCloseHit(g, -3, false, materialCloseCenter(g, -3, false).x, close.y)).toBe(false);
  expect(materialCloseCenter(g, -3, false).visible).toBeLessThan(MATERIAL_DECK.closeShownFrom);
});

onAndroid("the deck keeps its card geometry where the Material bars fit, and moves the cards between the 64 dp top app bar and the bottom row of search and FAB where they don't", () => {
  const tall = materialDeckGeometry(393, 873, SAFE.top, SAFE.bottom, 0, "android", deckHeaderBottom(), 55);
  expect(tall).toEqual(deckGeometry(393, 873, SAFE.top, SAFE.bottom, 0, "android", "material", deckHeaderBottom(), 55));
  expect(fitsMaterialChrome(tall)).toBe(true);
  const short = materialDeckGeometry(360, 740, 52, 48, 0, "android", deckHeaderBottom(), 55);
  expect(fitsMaterialChrome(deckGeometry(360, 740, 52, 48, 0, "android", "material", deckHeaderBottom(), 55))).toBe(false);
  expect(fitsMaterialChrome(short)).toBe(true);
  expect(short.cardCenterY - short.cardHeight / 2 - 8 - 20).toBeGreaterThanOrEqual(52 + 64);
  expect(short.cardCenterY + short.cardHeight / 2).toBeLessThanOrEqual(740 - 48 - 16 - 56);
  expect(short.barCenterY).toBe(740 - 48 - 8 - 32);
  expect(short.safeBottom).toBe(48);
});

onAndroid("the transparent header keeps the title and the 48 dp More button above the cards", () => {
  const root = deck();
  expect(flat(host(root, "materialDeckTopBar"))).toMatchObject({ paddingTop: SAFE.top, height: SAFE.top + 64 });
  expect(flat(host(root, "materialDeckTopBar")).backgroundColor).toBeUndefined();
  expect(flat(host(root, "materialDeckTitle"))).toMatchObject({ fontSize: 16, lineHeight: 24, color: LIGHT.onSurface });
  const more = pressable(root, "materialDeckMore")!;
  expect(more.props.accessibilityLabel).toBe("More");
  expect(flat(more)).toMatchObject({ width: 48, height: 48 });
  expect(more.props.android_ripple).toMatchObject({ borderless: true, radius: 20 });
  const trigger = root.root.findAll((node) => node.type === MenuTrigger && node.findAll((inner) => inner.props.testID === "materialDeckMore").length > 0)[0]!;
  expect(trigger.props.trigger).toBe("tap");
  expect(trigger.props.items.filter((item: unknown) => item !== "divider").map((item: { label: string }) => item.label)).toEqual(["Archive", "New Incognito Tab", "Close All Tabs", "Settings"]);
  unmount(root);
});

onAndroid("the capsule keeps add on the right with a 48 dp target and its long press menu", () => {
  const opened = jest.spyOn(browse, "newTab").mockImplementation(() => undefined);
  const root = deck();
  const fab = pressable(root, "materialDeckFab")!;
  expect(fab.props.accessibilityLabel).toBe("New Tab");
  expect(flat(fab)).toMatchObject({ width: 48, height: 48, borderRadius: 9999 });
  expect(flat(fab).backgroundColor).toBeUndefined();
  expect(fab.props.android_ripple).toMatchObject({ borderless: true, radius: 20 });
  act(() => fab.props.onPress());
  expect(opened).toHaveBeenCalledTimes(1);
  const trigger = root.root.findAll((node) => node.type === MenuTrigger && node.findAll((inner) => inner.props.testID === "materialDeckFab").length > 0)[0]!;
  expect(trigger.props.trigger).toBe("longPress");
  expect(trigger.props.items.map((item: { label: string }) => item.label)).toContain("New Incognito Tab");
  const row = flat(host(root, "materialDeckBottomRow"));
  expect(row).toMatchObject({ bottom: SAFE.bottom + 8, right: 16, height: 64, borderRadius: 9999, backgroundColor: LIGHT.surfaceContainer });
  unmount(root);
});

onAndroid("Search Tabs occupies the capsule center and still filters cards", () => {
  const root = deck();
  expect(flat(host(root, "materialDeckSearch"))).toMatchObject({ height: 48, borderRadius: 9999, backgroundColor: LIGHT.surfaceContainerHigh });
  const field = root.root.findAll((node) => node.props.testID === "deckSearchField" && typeof node.props.onChangeText === "function")[0]!;
  expect(field.props.placeholder).toBe("Search Tabs");
  act(() => field.props.onChangeText("Site 2"));
  act(() => jest.advanceTimersByTime(1000));
  expect(cards(root).length).toBe(1);
  const clear = pressable(root, "materialDeckSearchClear")!;
  expect(flat(clear)).toMatchObject({ width: 48, height: 48 });
  unmount(root);
});

onAndroid("Incognito takes the dark scheme of the same colours: its switch's eyes, its cards, and in Incognito the deck's surface and FAB", () => {
  withPrivates(2);
  const root = deck();
  const toggle = pressable(root, "materialDeckIncognito")!;
  expect(toggle.props.accessibilityLabel).toBe("Incognito");
  expect(toggle.props.accessibilityValue).toEqual({ text: "Off" });
  expect(flat(toggle)).toMatchObject({ width: 48, height: 48 });
  expect(toggle.props.android_ripple).toBeDefined();
  expect(toggle.findAll((node) => node.type === IncognitoEyes && node.props.incognito === false)).toHaveLength(1);
  expect(host(root, "materialDeckTopBar")!.findAll((node) => node.type === IncognitoEyes)).toHaveLength(0);
  expect(cards(root).map((card) => flat(card).backgroundColor)).toEqual(Array(4).fill(LIGHT.surfaceContainerLow));
  expect(host(root, "materialCardIncognitoIcon")).toBeUndefined();
  expect(flat(host(root, "materialDeckBackdrop")).backgroundColor).toBe(LIGHT.surface);
  unmount(root);
  withPrivates(2, true);
  const incognito = deck();
  expect(cards(incognito).map((card) => flat(card).backgroundColor)).toEqual(Array(2).fill(DARK.surfaceContainerLow));
  expect(flat(host(incognito, "materialCardIncognitoIcon")).backgroundColor).toBe(DARK.surfaceContainerHighest);
  expect(pressable(incognito, "materialDeckIncognito")!.props.accessibilityValue).toEqual({ text: "On" });
  expect(pressable(incognito, "materialDeckIncognito")!.findAll((node) => node.type === IncognitoEyes && node.props.incognito === true)).toHaveLength(1);
  expect(flat(host(incognito, "materialDeckBackdrop")).backgroundColor).toBe("#000000");
  expect(flat(host(incognito, "materialDeckTopBar")).backgroundColor).toBeUndefined();
  expect(flat(host(incognito, "materialDeckBottomRow")).backgroundColor).toBe("#000000");
  expect(flat(host(incognito, "materialDeckSearch")).backgroundColor).toBe("#000000");
  const fab = pressable(incognito, "materialDeckFab")!;
  expect(fab.props.accessibilityLabel).toBe("New Incognito Tab");
  expect(flat(fab).backgroundColor).toBeUndefined();
  for (const title of hosts(incognito, "deckHeaderTitle")) expect(flat(title).color).toBe(DARK.onSurface);
  unmount(incognito);
});

onAndroid("the bar's Incognito switch: a tap shows only the Incognito tabs, a second tap only the others, holding it closes them after asking, and with none it has no long press", () => {
  withPrivates(2);
  const root = deck();
  expect(cards(root)).toHaveLength(4);
  act(() => pressable(root, "materialDeckIncognito")!.props.onPress());
  act(() => jest.advanceTimersByTime(1000));
  expect(useTabs.getState().incognito).toBe(true);
  expect(cards(root)).toHaveLength(2);
  expect(telemetry.countUsage).toHaveBeenCalledWith("deck_incognito_switches");
  act(() => pressable(root, "materialDeckIncognito")!.props.onPress());
  act(() => jest.advanceTimersByTime(1000));
  expect(useTabs.getState().incognito).toBe(false);
  expect(cards(root)).toHaveLength(4);
  unmount(root);
  withPrivates(0);
  const none = deck();
  expect(pressable(none, "materialDeckIncognito")!.props.onLongPress).toBeUndefined();
  unmount(none);
  withPrivates(2);
  const leave = jest.spyOn(browse, "leaveIncognito").mockImplementation(() => undefined);
  const held = deck();
  act(() => pressable(held, "materialDeckIncognito")!.props.onLongPress());
  const labels = held.root.findAll((node) => node.props.accessibilityRole === "menuitem" && typeof node.type === "string").map((node) => node.props.accessibilityLabel);
  expect(labels).toEqual(["Close Incognito Tabs"]);
  unmount(held);
  leave.mockRestore();
});

onAndroid("a scheme change re-themes the open deck: cards, search, FAB and the Incognito switch's eyes", () => {
  withPrivates(1);
  const root = deck();
  act(() => setDynamicScheme(WALLPAPER));
  expect(flat(cards(root).find((card) => flat(card).backgroundColor !== WALLPAPER.dark.surfaceContainerLow))!.backgroundColor).toBe("#ABCDEF");
  expect(flat(host(root, "materialDeckTopBar")).backgroundColor).toBeUndefined();
  expect(flat(host(root, "materialDeckBottomRow")).backgroundColor).toBe(WALLPAPER.light.surfaceContainer);
  expect(flat(host(root, "materialDeckSearch")).backgroundColor).toBe(WALLPAPER.light.surfaceContainerHigh);
  expect(pressable(root, "materialDeckIncognito")!.findAll((node) => node.type === IncognitoEyes)[0]!.props.color).toBe(WALLPAPER.light.onSurfaceVariant);
  unmount(root);
});

onAndroid("the empty material deck says so in Material type with Open Archive as a text button", () => {
  act(() => useTabs.setState((state) => ({ ...state, open: [], privates: [], archivedCount: 3 })));
  const root = deck();
  const empty = host(root, "materialDeckEmpty")!;
  const title = empty.findAll((node) => typeof node.type === "string" && node.props.children === "No Open Tabs")[0]!;
  expect(flat(title)).toMatchObject({ fontSize: 22, color: LIGHT.onSurface });
  unmount(root);
});

onAndroid("the classic and redesigned decks keep their own chrome and cards: no Material bar, FAB or card close", () => {
  for (const design of ["original", "redesigned"] as const) {
    const root = deck(design);
    expect(host(root, "materialDeckTopBar")).toBeUndefined();
    expect(host(root, "materialDeckFab")).toBeUndefined();
    expect(host(root, "materialCardClose")).toBeUndefined();
    expect(host(root, "materialDeckBackdrop")).toBeUndefined();
    expect(cards(root).length).toBe(4);
    unmount(root);
  }
});

onAndroid("the More button gives the bar's press haptic on press down", () => {
  const root = deck();
  act(() => pressable(root, "materialDeckMore")!.props.onPressIn());
  expect(haptics.barPress).toHaveBeenCalledTimes(1);
  unmount(root);
});

onAndroid("a tap on the bottom row's Search Tabs field never dismisses the keyboard, so the field keeps the focus it just took", () => {
  const dismissed = jest.spyOn(Keyboard, "dismiss");
  const root = deck();
  tapDeckAt(150, 873 - SAFE.bottom - MATERIAL_DECK.edge - 28);
  expect(dismissed).not.toHaveBeenCalled();
  unmount(root);
});

test("the Material deck opens on the active card itself, so a last tab opens fully on screen, as main's designs now do", () => {
  expect(deckOpeningScroll(2, 3, true)).toBe(2);
  expect(deckOpeningScroll(2, 3, false)).toBe(openingDeckScroll(2, 3, true));
  expect(deckOpeningScroll(0, 3, true)).toBe(0);
});

onAndroid("the Incognito switch sits on the capsule's left where the redesign has it, with Search Tabs centered and add on the right, and the Archive stays in the ··· menu", () => {
  const root = deck();
  const order = root.root.findAll((found) => typeof found.type === "string" && ["materialDeckIncognito", "materialDeckSearch", "materialDeckFab"].includes(found.props.testID)).map((found) => found.props.testID);
  expect(order).toEqual(["materialDeckIncognito", "materialDeckSearch", "materialDeckFab"]);
  expect(host(root, "materialDeckArchive")).toBeUndefined();
  unmount(root);
});

test("the deck's search row rises by the whole keyboard on Android, whose reported height leaves out the navigation bar", () => {
  expect(materialKeyboardLift(300, 48, "android")).toBe(300 + MATERIAL_DECK.keyboardGap - 8);
  expect(materialKeyboardLift(300, 34, "ios")).toBe(300 + MATERIAL_DECK.keyboardGap - 34 - 8);
});
