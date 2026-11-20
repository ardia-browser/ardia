import { act, type ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import * as browse from "../state/browse/store";
import { presentSearch, searchState } from "../state/search/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const lookModule = require("@ardia/phone-native/src/look") as typeof import("@ardia/phone-native/src/look");

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const blocksTouches = (node: ReactTestInstance | null): boolean => {
  for (let at = node; at; at = at.parent) if (typeof at.type === "string" && at.props.pointerEvents === "none") return true;
  return false;
};

const closeSearchButton = (root: Root) => root.root.findAll((node) => node.props.accessibilityLabel === "Close Search" && typeof node.props.onPress === "function")[0]!;

test("with the look's fallback views, the page under an open tray takes no touches while the dim above the tray does, and one tap on it closes the tray once", () => {
  expect(lookModule.lookIsNative()).toBe(false);
  const cancel = jest.spyOn(browse, "cancelSearch");
  const root = renderSurface(<Surfaces />);
  const page = root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityLabel === "Tabs")[0]!;
  expect(page).toBeDefined();
  expect(blocksTouches(page)).toBe(false);
  act(() => presentSearch("page", ""));
  act(() => jest.advanceTimersByTime(50));
  expect(blocksTouches(page)).toBe(true);
  const dim = closeSearchButton(root);
  expect(blocksTouches(dim)).toBe(false);
  act(() => {
    dim.props.onPressIn?.();
    dim.props.onPress();
  });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(searchState().open).toBe(false);
  act(() => jest.advanceTimersByTime(2000));
  expect(blocksTouches(page)).toBe(false);
  unmount(root);
});

test("Close Search keeps working on a tray whose first close didn't take, instead of going dead for the rest of the tray", () => {
  const cancel = jest.spyOn(browse, "cancelSearch").mockImplementationOnce(() => undefined);
  const root = renderSurface(<Surfaces />);
  act(() => presentSearch("page", ""));
  act(() => jest.advanceTimersByTime(50));
  act(() => {
    closeSearchButton(root).props.onPressIn();
    closeSearchButton(root).props.onPress();
  });
  expect(searchState().open).toBe(true);
  expect(cancel).toHaveBeenCalledTimes(1);
  act(() => {
    closeSearchButton(root).props.onPressIn();
    closeSearchButton(root).props.onPress();
  });
  expect(cancel).toHaveBeenCalledTimes(2);
  expect(searchState().open).toBe(false);
  unmount(root);
});
