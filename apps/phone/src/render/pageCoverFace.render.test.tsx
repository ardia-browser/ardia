import { act, type ReactTestInstance } from "react-test-renderer";
import { PageCover } from "../components/browsing/PageCover";
import { useBrowse } from "../state/browse/store";
import { storeNavigation, usePages, type PageState } from "../state/pages/store";
import { currentTabs } from "../state/tabs/store";
import type { BrowserTab } from "../state/tabs/tabModels";
import { renderSurface, unmount, updateSurface, withTabs } from "../../test/render/harness";

const loading = { isLive: true, isLoading: true, url: "https://site0.example/", title: "Site 0", failure: null, progress: 0.5 } as unknown as PageState;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  usePages.setState({ navigation: {}, tones: {} });
  useBrowse.setState({ surface: "deck", opening: null });
});
afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

type Root = ReturnType<typeof renderSurface>;

const placeholder = (root: Root) => root.root.findAll((node) => node.props.testID === "pageLoadingPlaceholder" && typeof node.type === "string").length > 0;
const pictures = (root: Root) => root.root.findAll((node: ReactTestInstance) => typeof node.type === "function" && node.type.name === "Snapshot").length;
const words = (root: Root) =>
  root.root
    .findAll((node) => node.props.testID === "pageCover" && typeof node.type === "string")[0]!
    .findAll((node) => typeof node.type === "string" && node.type === "Text")
    .map((node) => node.props.children)
    .flat();

const pictured = (tab: BrowserTab): BrowserTab => ({ ...tab, snapshotFileName: "file:///pictures/t0.jpg" });

test("a card opened from the deck with no picture is covered by the same face the card showed, never the centred loading placeholder, so the grown card hands over to its own face", () => {
  const tab = currentTabs().open[0]!;
  storeNavigation(tab.id, loading);
  useBrowse.setState({ opening: tab.id });
  const root = renderSurface(<PageCover tab={tab} />, { flushTimers: false });
  expect(placeholder(root)).toBe(false);
  expect(words(root)).toEqual(["Site 0", "site0.example"]);
  unmount(root);
});

test("a picture saved while the cover shows doesn't swap the cover's face mid-load: the cover keeps what it first drew until it fades", () => {
  const tab = currentTabs().open[0]!;
  storeNavigation(tab.id, loading);
  useBrowse.setState({ opening: tab.id });
  const root = renderSurface(<PageCover tab={tab} />, { flushTimers: false });
  updateSurface(root, <PageCover tab={pictured(tab)} />);
  expect(pictures(root)).toBe(0);
  expect(words(root)).toEqual(["Site 0", "site0.example"]);
  unmount(root);
});

test("a page opened anywhere but the deck keeps the loading placeholder, and a picture saved under it doesn't swap it for a face", () => {
  const tab = currentTabs().open[0]!;
  storeNavigation(tab.id, loading);
  const root = renderSurface(<PageCover tab={tab} />, { flushTimers: false });
  expect(placeholder(root)).toBe(true);
  updateSurface(root, <PageCover tab={pictured(tab)} />);
  expect(placeholder(root)).toBe(true);
  expect(pictures(root)).toBe(0);
  unmount(root);
});

test("a tab with a picture is covered by that picture over its face, as before", () => {
  const tab = pictured(currentTabs().open[0]!);
  storeNavigation(tab.id, loading);
  const root = renderSurface(<PageCover tab={tab} />, { flushTimers: false });
  expect(placeholder(root)).toBe(false);
  expect(pictures(root)).toBe(1);
  unmount(root);
});
