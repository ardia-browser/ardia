import { Platform, StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { pages } from "@ardia/phone-native";
import { StartScreen } from "../components/search/StartScreen";
import { AboutPage } from "../components/settings/DataPages";
import { GeneralPane, SettingsPaneList } from "../components/settings/SettingsPanes";
import { DesignProvider } from "../components/ui";
import { downloads } from "../platform/downloads";
import { markUpdateSeen, UPDATE_SEEN_KEY, useAppUpdate } from "../state/appUpdate/store";
import * as browse from "../state/browse/store";
import { readPreference, writePreference } from "../state/store/browserDatabase";
import { browserDatabase } from "../state/store/database";
import type { Design } from "../lib/design";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const releaseBuild = Platform.OS === "android" && !__DEV__;
const APK = "https://github.com/ardia-browser/ardia/releases/download/android-v1.0.4/Ardia-1.0.4.apk";
const offer = { version: "1.0.4", downloadUrl: APK, checksumUrl: `${APK}.sha256`, sha256: null };

jest.spyOn(pages, "appRelease").mockReturnValue({ releaseVersion: "1.0.3", build: "100003999", receiptName: null });
jest.spyOn(downloads, "appUpdateStatus").mockResolvedValue("gone");

type Root = ReturnType<typeof renderSurface>;
const dots = (root: Root) => root.root.findAll((found) => found.props.testID === "updateDot" && typeof found.type === "string");
const labelled = (root: Root, pattern: RegExp) => root.root.findAll((found: ReactTestInstance) => typeof found.type === "string" && typeof found.props.accessibilityLabel === "string" && pattern.test(found.props.accessibilityLabel));

const startIn = (design: Design) =>
  renderSurface(
    <DesignProvider design={design}>
      <StartScreen />
    </DesignProvider>,
  );

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(0);
  writePreference(browserDatabase(), UPDATE_SEEN_KEY, null);
  act(() => browse.useBrowse.setState({ surface: "start", sheet: null }));
  act(() => useAppUpdate.setState({ status: "available", offer, handoff: null, progress: null, seenVersion: null }));
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

test.each(["redesigned", "original", "material"] as const)("the %s start page's Settings gear carries a quiet dot while an update waits, and loses it once About is seen", (design) => {
  const root = startIn(design);
  if (!releaseBuild) {
    expect(dots(root)).toHaveLength(0);
    unmount(root);
    return;
  }
  const [dot] = dots(root);
  expect(dot).toBeDefined();
  expect(StyleSheet.flatten(dot!.props.style)).toMatchObject({ width: 7, height: 7, borderRadius: 3.5, position: "absolute" });
  expect(dot!.props.pointerEvents).toBe("none");
  expect(labelled(root, /^Settings, update available$/).length).toBeGreaterThan(0);
  act(() => markUpdateSeen());
  expect(dots(root)).toHaveLength(0);
  expect(labelled(root, /update available/)).toHaveLength(0);
  expect(readPreference(browserDatabase(), UPDATE_SEEN_KEY)).toBe("1.0.4");
  unmount(root);
});

test("no dot when Ardia is current, when nothing was found, or for a version already seen; a newer version brings it back", () => {
  if (!releaseBuild) return;
  const root = startIn("redesigned");
  act(() => useAppUpdate.setState({ status: "current" }));
  expect(dots(root)).toHaveLength(0);
  act(() => useAppUpdate.setState({ status: "idle", offer: null }));
  expect(dots(root)).toHaveLength(0);
  act(() => useAppUpdate.setState({ status: "available", offer, seenVersion: "1.0.4" }));
  expect(dots(root)).toHaveLength(0);
  act(() => useAppUpdate.setState({ offer: { ...offer, version: "1.0.5" } }));
  expect(dots(root)).toHaveLength(1);
  unmount(root);
});

test("inside Settings the dot leads to About: on General in the pane list, on About Ardia in General, and opening About clears it", () => {
  if (!releaseBuild) return;
  for (const design of ["redesigned", "material"] as const) {
    act(() => useAppUpdate.setState({ status: "available", offer, seenVersion: null }));
    const list = renderSurface(
      <DesignProvider design={design}>
        <SettingsPaneList />
      </DesignProvider>,
    );
    expect(dots(list)).toHaveLength(1);
    expect(labelled(list, /^General, update available$/)).toHaveLength(1);
    unmount(list);
    const general = renderSurface(
      <DesignProvider design={design}>
        <GeneralPane />
      </DesignProvider>,
    );
    expect(dots(general)).toHaveLength(1);
    expect(labelled(general, /^About Ardia, update available$/)).toHaveLength(1);
    unmount(general);
    const about = renderSurface(
      <DesignProvider design={design}>
        <AboutPage />
      </DesignProvider>,
    );
    expect(useAppUpdate.getState().seenVersion).toBe("1.0.4");
    expect(dots(about)).toHaveLength(0);
    unmount(about);
  }
});
