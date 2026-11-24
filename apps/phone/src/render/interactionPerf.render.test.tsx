import { act } from "react-test-renderer";
import { Surfaces } from "../App";
import { beginInteraction, enableInteractionPerf, finishInteraction, INTERACTION_WINDOW_MS } from "../state/app/interactionPerf";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { useBrowse } from "../state/browse/store";
import { presentSearch } from "../state/search/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const lines: string[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  lines.length = 0;
  enableInteractionPerf(true, (line) => lines.push(line));
});

afterEach(() => {
  enableInteractionPerf(false, () => undefined);
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const renders = (line: string | undefined) => Number(/renders (\d+)/.exec(line ?? "")?.[1] ?? Number.NaN);

function frames(ms: number) {
  for (let at = 0; at < ms; at += 16) act(() => jest.advanceTimersByTime(16));
}

test("opening a card from a nine-card deck prints one lab line, and the deck's cards don't re-render frame by frame", () => {
  withTabs(9);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  act(() => sendDeckCommand({ kind: "openFocused" }));
  frames(INTERACTION_WINDOW_MS.cardOpen + 100);
  const line = lines.find((text) => text.startsWith("PAGELAB perf card open"));
  expect(line).toBeDefined();
  console.log(line);
  expect(renders(line)).toBeLessThan(60);
  unmount(root);
});

test("a deck scroll re-renders the deck only as the card nearest the centre changes, and no card twice", () => {
  withTabs(9);
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  act(() => beginInteraction("deck scroll", INTERACTION_WINDOW_MS.deckScroll));
  act(() => sendDeckCommand({ kind: "scroll", index: 2 }));
  frames(INTERACTION_WINDOW_MS.deckScroll + 100);
  const line = lines.find((text) => text.startsWith("PAGELAB perf deck scroll"));
  console.log(line);
  expect(Number(/DeckCard=(\d+)/.exec(line ?? "")?.[1] ?? 0)).toBeLessThanOrEqual(1);
  expect(renders(line)).toBeLessThan(12);
  unmount(root);
});

test("opening the tray over a page prints one lab line with its renders", () => {
  withTabs(3);
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  act(() => presentSearch("page", ""));
  frames(INTERACTION_WINDOW_MS.trayOpen + 100);
  const line = lines.find((text) => text.startsWith("PAGELAB perf tray open"));
  console.log(line);
  expect(line).toBeDefined();
  act(() => finishInteraction());
  unmount(root);
});
