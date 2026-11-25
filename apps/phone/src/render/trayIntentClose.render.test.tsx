import { AppState, Keyboard } from "react-native";
import { act } from "react-test-renderer";
import { SearchTray } from "../components/search/SearchTray";
import { openPage, useBrowse } from "../state/browse/store";
import { presentSearch } from "../state/search/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const appState = AppState as unknown as { currentState: string; addEventListener: jest.Mock };
const realState = appState.currentState;

beforeEach(() => {
  jest.useFakeTimers();
  appState.addEventListener.mockClear();
  withTabs(1);
  useBrowse.setState({ surface: "browsing", sheet: null });
});

afterEach(() => {
  appState.currentState = realState;
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const becomeActive = () =>
  act(async () => {
    appState.currentState = "active";
    for (const [event, listener] of appState.addEventListener.mock.calls as [string, (state: string) => void][]) if (event === "change") listener("active");
  });

const pass = async (ms: number) => {
  for (let at = 0; at < ms; at += 50) {
    await act(async () => {
      jest.advanceTimersByTime(50);
    });
  }
};

const trayShown = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.props.testID === "trayDim" && typeof node.type === "string").length > 0;

test("a link opened by intent while the app is away closes the tray, which stays until the app comes back and then puts its keyboard away again, so Android can't hand focus back to a field that is gone", async () => {
  const dismiss = jest.spyOn(Keyboard, "dismiss");
  presentSearch("page", "");
  const root = renderSurface(<SearchTray />);
  expect(trayShown(root)).toBe(true);
  appState.currentState = "background";
  act(() => openPage("https://otter.example/", "link"));
  expect(dismiss).toHaveBeenCalledTimes(1);
  await pass(5000);
  expect(trayShown(root)).toBe(true);
  expect(dismiss).toHaveBeenCalledTimes(1);
  await becomeActive();
  await pass(50);
  expect(dismiss).toHaveBeenCalledTimes(2);
  unmount(root);
});

test("with the app in front the tray closes as before, without waiting for the app to come back", async () => {
  const dismiss = jest.spyOn(Keyboard, "dismiss");
  presentSearch("page", "");
  const root = renderSurface(<SearchTray />);
  const listenersBefore = appState.addEventListener.mock.calls.filter(([event]) => event === "change").length;
  act(() => openPage("https://otter.example/", "link"));
  expect(dismiss).toHaveBeenCalledTimes(1);
  await pass(3000);
  expect(appState.addEventListener.mock.calls.filter(([event]) => event === "change")).toHaveLength(listenersBefore);
  unmount(root);
});
