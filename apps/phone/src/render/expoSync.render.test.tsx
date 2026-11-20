import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { SettingsView } from "../components/settings/SettingsView";
import { openSettings, settingsNav } from "../state/settings/nav";
import * as syncActions from "../state/sync/actions";
import { OFF_STATUS, useSync } from "../state/sync/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;

const EMPTY_VIEW = { devices: [], profiles: [], search: null, syncedAt: null, selectedProfileId: null, receivers: [] };
const MAC = { id: "mac", name: "MacBook Pro", kind: "mac", lastSeen: null, isCurrent: false, canReceiveTabs: true };

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  useSync.setState((state) => ({ ...state, status: OFF_STATUS, view: EMPTY_VIEW as never }));
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  useSync.setState((state) => ({ ...state, status: OFF_STATUS, view: EMPTY_VIEW as never }));
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const page = (root: Root) => root.root.findAll((node) => typeof node.type === "string" && node.props.name === "destination" && (node.props.extraProps as { value?: string } | undefined)?.value === "sync")[0]!;
const within = (node: ReactTestInstance, has: (props: Record<string, unknown>) => boolean) => node.findAll((inner) => typeof inner.type === "string" && has(inner.props));
const texts = (node: ReactTestInstance) => within(node, (props) => typeof props.text === "string").map((inner) => inner.props.text as string);
const titles = (node: ReactTestInstance) => within(node, (props) => typeof props.title === "string").map((inner) => inner.props.title as string);
const labels = (node: ReactTestInstance) => within(node, (props) => typeof props.label === "string").map((inner) => inner.props.label as string);
const press = async (node: ReactTestInstance) => act(async () => void (node.props.onButtonPress ?? node.props.onPress)({ nativeEvent: {} }));

onIos("on iPhone Sync With Mac is main's page on Expo UI: off, it shows the hero, a prominent capsule that opens Connect to Your Mac (a button, since a NavigationLink in a Form row drops its button style), and What You Get", async () => {
  openSettings({ page: "sync" });
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  expect(texts(page(root))).toEqual(expect.arrayContaining(["Sync With Mac", "Connect to Your Mac", "Your Mac’s Tabs", "Pinned Tabs and Spaces", "Send Tabs Both Ways", "History and Bookmarks"]));
  expect(titles(page(root))).toContain("What You Get");
  const connect = within(page(root), (props) => Array.isArray(props.modifiers) && (props.modifiers as { $type: string; style?: string }[]).some((modifier) => modifier.$type === "buttonStyle" && modifier.style === "borderedProminent"))[0]!;
  expect(texts(connect)).toEqual(["Connect to Your Mac"]);
  await press(connect);
  expect(settingsNav().stack.at(-1)).toEqual({ page: "syncConnect" });
  unmount(root);
});

onIos("connected, it has Sync Now, the Mac under Devices, this phone's name, the folder, and Stop Syncing behind main's confirmation", async () => {
  const stop = jest.spyOn(syncActions, "stopSyncing").mockResolvedValue(undefined);
  useSync.setState((state) => ({ ...state, status: { ...OFF_STATUS, isEnabled: true, phase: "updated", deviceName: "Test Phone", folderName: "Ardia Sync" }, view: { ...EMPTY_VIEW, devices: [MAC] } as never }));
  openSettings({ page: "sync" });
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  expect(texts(page(root))).toEqual(expect.arrayContaining(["Sync Now", "Ardia Sync", "Stop Syncing…", "To sync again, you’ll need your Mac’s code or your recovery phrase."]));
  expect(titles(page(root))).toEqual(expect.arrayContaining(["Devices", "Sync Folder", "MacBook Pro", "Stop Syncing This Device?"]));
  expect(labels(page(root))).toEqual(expect.arrayContaining(["Change Folder…", "Folder", "Stop Syncing"]));
  expect(texts(page(root))).not.toContain("What You Get");
  await press(within(page(root), (props) => props.label === "Stop Syncing")[0]!);
  expect(stop).toHaveBeenCalledTimes(1);
  unmount(root);
});
