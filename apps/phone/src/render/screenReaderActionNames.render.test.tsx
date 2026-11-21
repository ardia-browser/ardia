import type { ReactTestInstance } from "react-test-renderer";
import { act } from "react-test-renderer";
import { Platform } from "react-native";
import { BottomBar } from "../components/browsing/BottomBar";
import { SearchTray } from "../components/search/SearchTray";
import { TrustedSitesPage } from "../components/settings/BlockingPages";
import { TabDeck } from "../components/tabs/TabDeck";
import { rolesFor } from "../components/ui";
import { useBrowse } from "../state/browse/store";
import { presentSearch, useSearch } from "../state/search/store";
import { useBlocking } from "../state/settings/actions";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const ANDROID_NAMES = new Set(["activate", "longpress", "previousTab", "nextTab", "close", "dismiss", "remove", "refine", "menu", "menu0", "menu1", "menu2"]);

function actionNames(root: ReturnType<typeof renderSurface>): string[] {
  return root.root
    .findAll((node: ReactTestInstance) => typeof node.type === "string" && Array.isArray(node.props.accessibilityActions))
    .flatMap((node) => (node.props.accessibilityActions as { name: string; label?: string }[]).map((action) => action.name));
}

function everySurface(): string[] {
  const names: string[] = [];
  withTabs(3);
  const bar = renderSurface(
    <BottomBar order={currentTabs().open} roles={rolesFor(false)} showsPlus onTabs={() => undefined} onTabsMenu={() => undefined} onStep={() => undefined} onPlus={() => undefined} onMore={() => undefined} />,
  );
  names.push(...actionNames(bar));
  unmount(bar);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const deck = renderSurface(<TabDeck />);
  names.push(...actionNames(deck));
  unmount(deck);
  useBlocking.setState({ busy: false, state: { exemptHosts: ["alpha.example"], lists: [] } as never });
  const trusted = renderSurface(<TrustedSitesPage />);
  names.push(...actionNames(trusted));
  unmount(trusted);
  useBrowse.setState({ surface: "start" });
  presentSearch("start", "otter");
  useSearch.setState({ rows: [{ key: "q0", kind: "query", title: "otters", url: "https://duckduckgo.com/?q=otters", query: "otters" }], text: "otter" });
  const tray = renderSurface(<SearchTray />);
  names.push(...actionNames(tray));
  unmount(tray);
  return names;
}

const onIos = Platform.OS === "ios" ? test : test.skip;
const onAndroid = Platform.OS === "android" ? test : test.skip;

onIos("on iPhone every custom accessibility action has a human name, since VoiceOver reads the name, and activate is left to VoiceOver's double tap", () => {
  const names = everySurface();
  expect(names.length).toBeGreaterThan(3);
  for (const name of names) {
    expect(name).not.toBe("activate");
    expect(name).toMatch(/^[A-Z][a-z]*( [\w.“”’-]+)*$/u);
  }
});

onAndroid("on Android the actions keep their names and labels, as TalkBack reads the labels", () => {
  const names = everySurface();
  expect(names).toContain("activate");
  expect(names).toContain("previousTab");
  for (const name of names) expect(ANDROID_NAMES.has(name)).toBe(true);
});
