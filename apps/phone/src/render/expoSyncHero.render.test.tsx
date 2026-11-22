import type { ReactNode } from "react";
import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { SettingsView } from "../components/settings/SettingsView";
import { openSettings } from "../state/settings/nav";
import { OFF_STATUS, useSync } from "../state/sync/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

jest.mock("../components/ui", () => ({
  ...jest.requireActual<object>("../components/ui"),
  settingsUIAvailable: () => true,
  SettingsHeroContent: ({ children, ...props }: { children?: ReactNode }) => jest.requireActual<typeof import("react")>("react").createElement("SettingsHeroContentView", props, children),
}));

const onIos = Platform.OS === "ios" ? test : test.skip;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  useSync.setState((state) => ({ ...state, status: OFF_STATUS }));
  jest.useRealTimers();
});

const heroOf = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.type === "SettingsHeroContentView")[0]!;

onIos("Sync With Mac's hero subtitle is a warning when sync needs attention, as main's turns orange, and plain otherwise", async () => {
  openSettings({ page: "sync" });
  const off = renderSurface(<SettingsView />);
  await act(async () => undefined);
  expect(heroOf(off).props.subtitleIsWarning).toBe(false);
  await act(async () => void jest.advanceTimersByTime(1000));
  unmount(off);
  useSync.setState((state) => ({ ...state, status: { ...OFF_STATUS, isEnabled: true, phase: "needsFolderAccess", attention: "folder", statusText: "Can’t Open the Sync Folder" } }));
  openSettings({ page: "sync" });
  const attention = renderSurface(<SettingsView />);
  await act(async () => undefined);
  expect(heroOf(attention).props.subtitleIsWarning).toBe(true);
  expect(heroOf(attention).props.subtitle).toBe("Can’t Open the Sync Folder");
  await act(async () => void jest.advanceTimersByTime(1000));
  unmount(attention);
});
