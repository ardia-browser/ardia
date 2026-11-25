import { AppState } from "react-native";
import { act } from "react-test-renderer";
import { LaunchRoot } from "../dev/LaunchRoot";
import { renderSurface, textOf, unmount } from "../../test/render/harness";

const mockLaunch: { pageLab: boolean; known: boolean } = { pageLab: false, known: true };

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual("@ardia/phone-native");
  return { ...actual, pages: { ...actual.pages, launchOptions: () => (mockLaunch.known ? { pageLab: mockLaunch.pageLab, syncDemo: false, lab: true, arguments: {} } : null) } };
});
jest.mock("../App", () => ({ __esModule: true, default: () => require("react").createElement(require("react-native").Text, null, "the app") }));
jest.mock("../dev/PageLab", () => ({ PageLab: () => require("react").createElement(require("react-native").Text, null, "the lab") }));

beforeEach(() => {
  jest.useFakeTimers();
  mockLaunch.pageLab = false;
  mockLaunch.known = true;
});
afterEach(() => jest.useRealTimers());

test("a lab build's lab launch reaches a running app, even one held on the import failure screen", () => {
  const root = renderSurface(<LaunchRoot />);
  act(() => jest.advanceTimersByTime(100));
  expect(textOf(root)).toContain("the app");
  mockLaunch.pageLab = true;
  const listeners = (AppState.addEventListener as unknown as jest.Mock).mock?.calls ?? [];
  act(() => listeners.forEach(([event, listener]: [string, (state: string) => void]) => event === "change" && listener("active")));
  expect(textOf(root)).toContain("the lab");
  unmount(root);
});


test("a lab build mounts the app on its first render, with no wait for the launch options, so it times its start as a release build does", () => {
  const root = renderSurface(<LaunchRoot />);
  expect(textOf(root)).toContain("the app");
  unmount(root);
});

test("a page-lab launch whose options are there at once shows the lab on the first render", () => {
  mockLaunch.pageLab = true;
  const root = renderSurface(<LaunchRoot />);
  expect(textOf(root)).toContain("the lab");
  unmount(root);
});

test("when the options come late, as on Android before the activity is attached, the app shows at once and a page-lab launch switches to the lab when they arrive", () => {
  mockLaunch.known = false;
  const root = renderSurface(<LaunchRoot />);
  expect(textOf(root)).toContain("the app");
  mockLaunch.known = true;
  mockLaunch.pageLab = true;
  act(() => jest.advanceTimersByTime(60));
  expect(textOf(root)).toContain("the lab");
  unmount(root);
});
