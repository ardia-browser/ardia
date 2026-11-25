import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const mockMotion = { reduced: false };
jest.mock("../state/app/systemLook", () => ({ ...jest.requireActual("../state/app/systemLook"), useReduceMotion: () => mockMotion.reduced }));

const { TabDeck } = require("../components/tabs/TabDeck") as typeof import("../components/tabs/TabDeck");
const browse = require("../state/browse/store") as typeof import("../state/browse/store");
const { sendDeckCommand } = require("../state/browse/deckCommands") as typeof import("../state/browse/deckCommands");

let closing: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1_790_000_000_000 + 60_000);
  withTabs(3);
  mockMotion.reduced = false;
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  closing = jest.spyOn(browse, "closeTabFromDeck").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  closing.mockRestore();
  mockMotion.reduced = false;
  jest.useRealTimers();
});

type Root = ReturnType<typeof renderSurface>;
type Look = { opacity: number; scale: number; y: number; blurred: boolean };

const ownerTab = (card: ReactTestInstance) => {
  let owner: ReactTestInstance | null = card;
  while (owner && !owner.props.tab) owner = owner.parent;
  return (owner?.props.tab as { id: string }).id;
};

const looks = (root: Root) => {
  const at = new Map<string, Look>();
  for (const card of root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string")) {
    const style = getAnimatedStyle(card) as { opacity?: number; filter?: unknown[]; transform?: { translateY?: number; scale?: number }[] };
    const steps = style.transform ?? [];
    at.set(ownerTab(card), { opacity: style.opacity ?? 1, scale: steps.find((step) => step.scale !== undefined)?.scale ?? 1, y: steps.reduce((sum, step) => sum + (step.translateY ?? 0), 0), blurred: (style.filter?.length ?? 0) > 0 });
  }
  return at;
};

function closeFocused(root: Root, frames: number) {
  const id = closing.mock.calls.length;
  act(() => sendDeckCommand({ kind: "closeFocused" }));
  expect(closing.mock.calls.length).toBe(id + 1);
  const closed = closing.mock.calls[id]![0] as string;
  const seen: (Look | undefined)[] = [];
  for (let frame = 0; frame < frames; frame++) {
    act(() => jest.advanceTimersByTime(16));
    seen.push(looks(root).get(closed));
  }
  return seen;
}

test("a closing card leaves whole: it rises at its full size and opacity, with no shrink, fade or blur, until it is off the top", () => {
  const root = renderSurface(<TabDeck />);
  const seen = closeFocused(root, 30).filter((look): look is Look => look !== undefined);
  expect(seen.length).toBeGreaterThan(2);
  for (const look of seen) expect(look).toMatchObject({ opacity: 1, scale: 1, blurred: false });
  expect(seen.at(-1)!.y).toBeLessThan(seen[0]!.y);
  unmount(root);
});

test("with Reduce Motion the closing card fades where it is as one layer, getting only fainter, and the gap closes on the same fade", () => {
  mockMotion.reduced = true;
  const root = renderSurface(<TabDeck />);
  const cards = root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string");
  for (const card of cards) expect(card.props.needsOffscreenAlphaCompositing).toBe(true);
  const seen = closeFocused(root, 20);
  const shown = seen.filter((look): look is Look => look !== undefined);
  expect(shown.some((look) => look.opacity > 0.1 && look.opacity < 0.9)).toBe(true);
  for (let i = 1; i < shown.length; i++) expect(shown[i]!.opacity).toBeLessThanOrEqual(shown[i - 1]!.opacity + 1e-6);
  for (const look of shown) expect(look.y).toBeCloseTo(shown[0]!.y, 3);
  expect(seen.at(-1)).toBeUndefined();
  unmount(root);
});
