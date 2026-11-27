import type { ReactNode } from "react";
import { Platform, StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { DEFAULT_PROFILE_COLOR, DesignProvider, OverlayHost, PROFILE_PRESETS, ProfileLookContext } from "../../src/components/ui";
import { useLook } from "../../src/state/sync/hooks";
import { usePreferences } from "../../src/state/settings/store";
import { useTabs } from "../../src/state/tabs/store";
import { launchTabs } from "../../src/state/tabs/tabsState";
import type { BrowserTab } from "../../src/state/tabs/tabModels";

const METRICS = { frame: { x: 0, y: 0, width: 393, height: 873 }, insets: { top: 40, left: 0, right: 0, bottom: 24 } };

function Look({ children }: { children: ReactNode }) {
  const look = useLook(PROFILE_PRESETS, DEFAULT_PROFILE_COLOR);
  return <ProfileLookContext.Provider value={look}>{children}</ProfileLookContext.Provider>;
}

const surface = (node: ReactNode) => (
  <GestureHandlerRootView style={StyleSheet.absoluteFill}>
    <SafeAreaProvider initialMetrics={METRICS}>
      <Look>
        <OverlayHost>{node}</OverlayHost>
      </Look>
    </SafeAreaProvider>
  </GestureHandlerRootView>
);

export function renderSurface(node: ReactNode, { flushTimers = true }: { flushTimers?: boolean } = {}): ReactTestRenderer {
  let root: ReactTestRenderer | null = null;
  act(() => {
    root = create(surface(node));
  });
  if (flushTimers) act(() => jest.runOnlyPendingTimers());
  return root!;
}

export function updateSurface(root: ReactTestRenderer, node: ReactNode) {
  act(() => root.update(surface(node)));
}

export function layOutDeckControls(root: ReactTestRenderer) {
  const targets = root.root.findAll((node) => typeof node.type === "string" && typeof node.props.testID === "string" && node.props.testID.startsWith("deckHit-"));
  targets.forEach((node, at) => act(() => node.props.onLayout({ nativeEvent: { layout: { x: 16 + at * 60, y: 0, width: 44, height: 44 } } })));
  act(() => jest.advanceTimersByTime(16));
}

export function unmount(root: ReactTestRenderer) {
  act(() => root.unmount());
}

const T = 1_790_000_000_000;

export function someTabs(count: number, isPrivate = false): BrowserTab[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${isPrivate ? "p" : "t"}${i}`,
    url: `https://site${i}.example/`,
    title: `Site ${i}`,
    created: T + i,
    lastActive: T + i,
    archivedAt: null,
    position: (i + 1) * 1024,
    profileSyncId: null,
    faviconUrl: null,
    themeColorHex: null,
    snapshotFileName: null,
    origin: "typed",
    receivedKey: null,
    receivedFromDevice: null,
    pinnedKey: null,
    isPrivate,
  }));
}

export function withTabs(count: number) {
  useTabs.setState({ ...launchTabs(someTabs(count), 0), incognito: false, listing: 0 });
}

export function textOf(root: ReactTestRenderer): string {
  return root.root
    .findAll((node) => typeof node.type === "string" && node.type === "Text")
    .map((node) => node.children.filter((child) => typeof child === "string").join(""))
    .join("\n");
}

export async function pressButton(root: ReactTestRenderer, title: string) {
  const button = root.root.findAll((node) => node.props.accessibilityRole === "button" && typeof node.props.onPress === "function" && textOf({ root: node } as ReactTestRenderer).includes(title))[0];
  if (!button) throw new Error(`no button titled ${title}`);
  await act(async () => {
    button.props.onPress();
  });
}

export function framesUntil(done: () => boolean, limit = 120) {
  for (let frame = 0; frame < limit && !done(); frame++) act(() => jest.advanceTimersByTime(16));
}

export function landOpeningPage(root: ReactTestRenderer) {
  const page = root.root.findAll((node) => (node.type as { name?: string })?.name === "BrowsingScreen")[0];
  if (!page) return false;
  const screen = page.findAll((node) => typeof node.type === "string" && typeof node.props.onLayout === "function")[0];
  if (screen) act(() => screen.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 393, height: 873 } } }));
  const cover = page.findAll((node) => node.props.testID === "pageCover" && typeof node.type === "string")[0];
  const picture = cover?.findAll((node) => typeof node.props.onLoad === "function" && node.props.source?.uri)[0];
  if (picture) act(() => picture.props.onLoad({ nativeEvent: { source: { width: 600, height: 1300 } } }));
  return true;
}

export const classicOnAndroid = (node: ReactNode) => (Platform.OS === "android" ? <DesignProvider design="original">{node}</DesignProvider> : node);

export function withMaterialYou() {
  beforeEach(() => usePreferences.setState({ materialYou: true }));
  afterEach(() => usePreferences.setState({ materialYou: false }));
}
