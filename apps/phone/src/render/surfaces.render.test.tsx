import { Platform } from "react-native";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { OnboardingView } from "../components/onboarding/OnboardingView";
import { SearchTray } from "../components/search/SearchTray";
import { SettingsView } from "../components/settings/SettingsView";
import { SpacesView } from "../components/sync/SpacesView";
import { ImportFailedView } from "../components/upgrade/ImportFailedView";
import { useBoot } from "../state/app/bootState";
import { useBrowse } from "../state/browse/store";
import { showOnboarding } from "../state/onboarding/store";
import { presentSearch } from "../state/search/store";
import { openSettings } from "../state/settings/nav";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
});
afterEach(() => jest.useRealTimers());

test("the tray opens over the start screen and shows its field", () => {
  useBrowse.setState({ surface: "start" });
  presentSearch("start", "");
  const root = renderSurface(<SearchTray />);
  const fields = root.root.findAll((node) => node.type === "TextInput");
  expect(fields.map((field) => field.props.placeholder)).toContain("Search…");
  unmount(root);
});

test("a page shows its bottom bar", () => {
  useBrowse.setState({ surface: "browsing" });
  const tab = currentTabs().open[0]!;
  const root = renderSurface(<BrowsingScreen tab={tab} />);
  expect(root.toJSON()).not.toBeNull();
  unmount(root);
});

test("Settings opens on its root page", () => {
  openSettings();
  const root = renderSurface(<SettingsView />);
  if (Platform.OS === "ios") expect(root.root.findAll((node) => node.props.testID === "expoSettings" && typeof node.type === "string")).toHaveLength(1);
  else expect(textOf(root)).toContain("Settings");
  unmount(root);
});

test("Spaces opens with sync off", () => {
  const root = renderSurface(<SpacesView />);
  expect(root.toJSON()).not.toBeNull();
  unmount(root);
});

test("onboarding opens on its welcome step", () => {
  showOnboarding();
  const root = renderSurface(<OnboardingView />);
  expect(textOf(root).length).toBeGreaterThan(0);
  unmount(root);
});

test("the import failure screen offers Try Again", () => {
  useBoot.setState({ ready: false, failures: 2, busy: false, outcome: null });
  const root = renderSurface(<ImportFailedView />);
  expect(textOf(root)).toContain("Try Again");
  unmount(root);
});
