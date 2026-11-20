import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { renderSurface, unmount } from "../../test/render/harness";

const { SettingsView } = require("../components/settings/SettingsView") as typeof import("../components/settings/SettingsView");
const nav = require("../state/settings/nav") as typeof import("../state/settings/nav");

const onAndroid = Platform.OS === "android" ? test : test.skip;

type Root = ReturnType<typeof renderSurface>;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  act(() => nav.closeSettings());
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const pages = (root: Root) => root.root.findAll((node) => typeof node.type === "string" && node.props.testID === "settingsPage");
const titleOf = (node: ReactTestInstance) => node.findAll((child) => child.props.testID === "settingsTitle" && typeof child.type === "string").map((child) => child.props.children)[0];
const settledTitle = (root: Root) => {
  const shown = pages(root);
  expect(shown).toHaveLength(1);
  return titleOf(shown[0]!);
};

function settings() {
  act(() => nav.openSettings());
  return renderSurface(<SettingsView />);
}

onAndroid("on Android a Settings push and Back show the destination at once as the only mounted page over the sheet's backdrop", () => {
  const root = settings();
  expect(root.root.findAll((node) => node.props.testID === "settingsStack" && typeof node.type === "string")).toHaveLength(1);
  expect(settledTitle(root)).toBe("Settings");
  act(() => nav.pushSettings({ page: "about" }));
  expect(settledTitle(root)).toBe("About Ardia");
  act(() => nav.pushSettings({ page: "licenses" }));
  expect(settledTitle(root)).toBe("Open Source Licenses");
  act(() => void nav.popSettings());
  expect(settledTitle(root)).toBe("About Ardia");
  act(() => void nav.popSettings());
  expect(settledTitle(root)).toBe("Settings");
  unmount(root);
});

onAndroid("on Android a direct Settings route opens on that page alone, and Back lands on the root at once", () => {
  act(() => nav.openSettings({ page: "about" }));
  const root = renderSurface(<SettingsView />);
  expect(settledTitle(root)).toBe("About Ardia");
  act(() => void nav.popSettings());
  expect(settledTitle(root)).toBe("Settings");
  act(() => nav.openSettingsPage({ page: "licenses" }));
  expect(settledTitle(root)).toBe("Open Source Licenses");
  unmount(root);
});

onAndroid("on Android closing Settings keeps the last page while the sheet carries it away, and the next open starts on the root alone", () => {
  const root = settings();
  act(() => nav.pushSettings({ page: "about" }));
  act(() => nav.closeSettings());
  expect(settledTitle(root)).toBe("About Ardia");
  act(() => nav.openSettings());
  expect(settledTitle(root)).toBe("Settings");
  unmount(root);
});
