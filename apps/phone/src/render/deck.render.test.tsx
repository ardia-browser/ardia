import { Platform } from "react-native";
import { TabDeck } from "../components/tabs/TabDeck";
import { useBrowse } from "../state/browse/store";
import { useTabs } from "../state/tabs/store";
import { launchTabs } from "../state/tabs/tabsState";
import { renderSurface, someTabs, textOf, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("the deck", () => {
  for (const count of [0, 1, 3, 9]) {
    test(`opens with ${count} tabs`, () => {
      withTabs(count);
      useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null });
      const root = renderSurface(<TabDeck />);
      const text = textOf(root);
      if (count === 0) expect(text).toContain("No Open Tabs");
      else expect(text).toContain(`Site ${count - 1}`);
      unmount(root);
    });
  }

  test("card titles stop growing at 1.35 times text size, as both native apps cap them", () => {
    withTabs(3);
    useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null });
    const root = renderSurface(<TabDeck />);
    const titles = root.root.findAll((node) => typeof node.type === "string" && node.props.testID === "deckHeaderTitle");
    expect(titles).toHaveLength(3);
    for (const title of titles) expect(title.props.maxFontSizeMultiplier).toBe(1.35);
    unmount(root);
  });

  test("on the Incognito side, which both phones' redesigned decks have, an Incognito card's header reads Incognito on iPhone, as main's SwiftUI deck does, and keeps the page's title on Android, as main's Compose deck does", () => {
    useTabs.setState({ ...launchTabs([...someTabs(2), ...someTabs(1, true)], 0), incognito: true, listing: 0 });
    useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null });
    const root = renderSurface(<TabDeck />);
    const titles = root.root.findAll((node) => typeof node.type === "string" && node.props.testID === "deckHeaderTitle").map((node) => node.props.children);
    expect(titles).toEqual([Platform.OS === "ios" ? "Incognito" : "Site 0"]);
    unmount(root);
  });
});
