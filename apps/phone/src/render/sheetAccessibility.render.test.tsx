import type { ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import { useBrowse } from "../state/browse/store";
import { openSettings, closeSettings } from "../state/settings/nav";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const deckOwned = (labels: string[]) => labels.filter((label) => label === "New Tab" || /^Site \d/.test(label));

function exposedLabels(root: ReturnType<typeof renderSurface>): string[] {
  const hidden = (node: ReactTestInstance | null): boolean => {
    for (let at = node; at; at = at.parent) {
      if (at.props.accessibilityElementsHidden === true || at.props.importantForAccessibility === "no-hide-descendants") return true;
    }
    return false;
  };
  return root.root
    .findAll((node) => typeof node.type === "string" && typeof node.props.accessibilityLabel === "string")
    .filter((node) => !hidden(node))
    .map((node) => node.props.accessibilityLabel as string);
}

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  closeSettings();
});
afterEach(() => jest.useRealTimers());

test("with the deck showing, its bar is reachable by a screen reader", () => {
  useBrowse.setState({ surface: "deck", sheet: null });
  const root = renderSurface(<Surfaces />);
  expect(deckOwned(exposedLabels(root))).toContain("New Tab");
  unmount(root);
});

for (const sheet of ["spaces", "archive", "settings"] as const) {
  test(`with ${sheet} open over the deck, nothing behind the sheet is exposed to a screen reader`, () => {
    useBrowse.setState({ surface: "deck", sheet: sheet === "settings" ? null : sheet });
    if (sheet === "settings") openSettings();
    const root = renderSurface(<Surfaces />);
    expect(deckOwned(exposedLabels(root))).toEqual([]);
    unmount(root);
  });
}
