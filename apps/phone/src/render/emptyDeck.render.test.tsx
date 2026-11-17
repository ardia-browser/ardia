import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { StartScreen } from "../components/search/StartScreen";
import { TabDeck } from "../components/tabs/TabDeck";
import { DesignProvider } from "../components/ui";
import type { Design } from "../lib/design";
import { haptics } from "../state/app/haptics";
import { closeAllFromDeck, closeTabFromDeck, useBrowse } from "../state/browse/store";
import { dismissSearch, searchState } from "../state/search/store";
import { currentPreferences, setPreference } from "../state/settings/store";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

jest.mock("../state/pages/store", () => ({ ...jest.requireActual("../state/pages/store"), endPages: () => undefined, deletePageSnapshots: () => undefined }));

const safeArea = require("react-native-safe-area-context") as { useSafeAreaInsets: () => { top: number; bottom: number; left: number; right: number } };

let press: jest.SpyInstance;
let keyboardWas: boolean;

beforeEach(() => {
  jest.useFakeTimers();
  keyboardWas = currentPreferences().autoOpensKeyboard;
  setPreference("autoOpensKeyboard", true);
  jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => ({ top: 47, bottom: 34, left: 0, right: 0 }));
  press = jest.spyOn(haptics, "barPress").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  setPreference("autoOpensKeyboard", keyboardWas);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const render = (node: React.ReactElement, design: Design = "redesigned") => renderSurface(<DesignProvider design={design}>{node}</DesignProvider>);

const pressIn = (root: Root, label: string) => {
  const target = root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPressIn === "function")[0];
  expect(target).toBeDefined();
  act(() => target!.props.onPressIn({}));
};

test("closing the deck's last tab hands over to the start screen at once, and the start screen rests: no tray, even with Open Keyboard on", () => {
  withTabs(1);
  act(() => useBrowse.setState({ surface: "deck", sheet: null }));
  act(() => closeTabFromDeck(currentTabs().open[0]!.id));
  expect(useBrowse.getState().surface).toBe("start");
  expect(searchState().open).toBe(false);
  act(() => jest.advanceTimersByTime(2000));
  expect(searchState().open).toBe(false);
});

test("Close All Tabs hands over to the start screen the same way", () => {
  withTabs(3);
  act(() => useBrowse.setState({ surface: "deck", sheet: null }));
  act(() => closeAllFromDeck());
  expect(currentTabs().open).toHaveLength(0);
  expect(useBrowse.getState().surface).toBe("start");
  expect(searchState().open).toBe(false);
});

test("closing a tab while others are left keeps the deck", () => {
  withTabs(3);
  act(() => useBrowse.setState({ surface: "deck", sheet: null }));
  act(() => closeTabFromDeck(currentTabs().open[0]!.id));
  expect(useBrowse.getState().surface).toBe("deck");
});

test("the start screen's Tabs, plus and Settings give the bar's press haptic on press down", () => {
  withTabs(2);
  act(() => useBrowse.setState({ surface: "start", sheet: null }));
  const root = render(<StartScreen />);
  for (const label of ["Tabs", "New Tab", "Settings"]) pressIn(root, label);
  expect(press).toHaveBeenCalledTimes(3);
  unmount(root);
});

test("the original start page's bar gives it too", () => {
  withTabs(2);
  act(() => useBrowse.setState({ surface: "start", sheet: null }));
  const root = render(<StartScreen />, "original");
  for (const label of ["Tabs", "New Tab", "Settings"]) pressIn(root, label);
  expect(press).toHaveBeenCalledTimes(3);
  unmount(root);
});

test("the deck's round buttons give the bar's press haptic on press down", () => {
  withTabs(3);
  act(() => useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null }));
  const root = render(<TabDeck />);
  const labels = ["More", "New Tab", ...(Platform.OS === "ios" ? ["Show as Grid"] : [])];
  for (const label of labels) pressIn(root, label);
  expect(press).toHaveBeenCalledTimes(labels.length);
  unmount(root);
});
