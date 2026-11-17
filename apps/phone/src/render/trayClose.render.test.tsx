import * as Reanimated from "react-native-reanimated";
import { getAnimatedStyle, KeyboardState, makeMutable } from "react-native-reanimated";
import { act } from "react-test-renderer";
import { SearchTray } from "../components/search/SearchTray";
import * as browse from "../state/browse/store";
import { presentSearch } from "../state/search/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

let keyboard: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  browse.useBrowse.setState({ surface: "browsing" });
  keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(300), state: makeMutable(KeyboardState.OPEN) }) as never);
});

afterEach(() => {
  keyboard.mockRestore();
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

test("closing the tray clears its dim even while a keyboard stays up, as one a page's own field took would", () => {
  presentSearch("page", "");
  const root = renderSurface(<SearchTray />);
  const dim = () => root.root.findAll((node) => node.props.testID === "trayDim" && typeof node.type === "string")[0];
  act(() => jest.advanceTimersByTime(600));
  expect(getAnimatedStyle(dim()!).opacity).toBeGreaterThan(0.9);
  act(() => browse.cancelSearch());
  act(() => jest.advanceTimersByTime(400));
  expect(dim()).toBeDefined();
  expect(getAnimatedStyle(dim()!).opacity).toBeLessThan(0.05);
  unmount(root);
});
