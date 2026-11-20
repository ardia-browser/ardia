import { act } from "react-test-renderer";
import { StartScreen } from "../components/search/StartScreen";
import { TabDeck } from "../components/tabs/TabDeck";
import { DesignProvider } from "../components/ui";
import { useBrowse } from "../state/browse/store";
import { dismissSearch, presentSearch } from "../state/search/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const lookModule = require("@ardia/phone-native/src/look") as typeof import("@ardia/phone-native/src/look");

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  jest.spyOn(lookModule, "lookIsNative").mockImplementation(() => true);
  jest.spyOn(lookModule, "glassIsNative").mockImplementation(() => false);
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const frosts = (root: Root) => root.root.findAll((node) => node.type === lookModule.Frost).length;
const plain = (root: Root) => root.root.findAll((node) => node.props.testID === "deckBarPlain" && typeof node.type === "string").length;

test("while the tray covers the deck, the deck bar's three buttons hold no frost, so the tray's rise blurs one layer instead of four", () => {
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(
    <DesignProvider design="original">
      <TabDeck />
    </DesignProvider>,
  );
  expect(frosts(root)).toBe(3);
  act(() => presentSearch("page", ""));
  expect(frosts(root)).toBe(0);
  expect(plain(root)).toBe(3);
  act(() => dismissSearch());
  expect(frosts(root)).toBe(3);
  unmount(root);
});

test("the start page's bar, faded out behind the launch tray, holds no frost either", () => {
  useBrowse.setState({ surface: "start", sheet: null });
  act(() => presentSearch("home", ""));
  const root = renderSurface(
    <DesignProvider design="original">
      <StartScreen />
    </DesignProvider>,
  );
  expect(frosts(root)).toBe(0);
  act(() => dismissSearch());
  expect(frosts(root)).toBe(3);
  unmount(root);
});
