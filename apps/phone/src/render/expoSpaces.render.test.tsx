import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import { haptics } from "../state/app/haptics";
import * as browse from "../state/browse/store";
import * as syncActions from "../state/sync/actions";
import { useSync } from "../state/sync/store";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;

const tabs = (count: number) => Array.from({ length: count }, (_, index) => ({ title: `Remote ${index}`, url: `https://remote${index}.example/` }));
const profile = (syncId: string, name: string, deviceTabs: { deviceId: string; deviceName: string; kind: string; tabs: { title: string; url: string }[] }[] = []) => ({
  syncId,
  name,
  color: null,
  icon: null,
  isDefault: syncId === "work",
  theme: null,
  deviceTabs,
  pinned: { tiles: [], sections: [] },
  bookmarks: [] as { key: string; title: string; url: string | null; added: number; root: string | null; children: unknown[] | null }[],
  history: [],
  sendTargets: null,
});

const withProfiles = (profiles: ReturnType<typeof profile>[], phase = "idle") =>
  useSync.setState((state) => ({
    ...state,
    status: { ...state.status, isEnabled: phase !== "off", phase } as never,
    view: { devices: [], profiles, search: null, syncedAt: 1, selectedProfileId: profiles[0]?.syncId ?? null, shownProfileId: profiles[0]?.syncId ?? null } as never,
  }));

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const hosts = (node: ReactTestInstance, has: (props: Record<string, unknown>) => boolean) => node.findAll((inner) => typeof inner.type === "string" && has(inner.props));
const spacesSheet = (root: Root) => hosts(root.root, (props) => props.testID === "expoSpacesSheet")[0]!;
const presented = (root: Root) => hosts(spacesSheet(root), (props) => typeof props.isPresented === "boolean")[0]!;
const pager = (root: Root) => hosts(spacesSheet(root), (props) => typeof props.selection === "string" && Array.isArray(props.modifiers) && (props.modifiers as { $type: string }[]).some((modifier) => modifier.$type === "tabViewStyle"))[0]!;
const settle = async () => act(async () => void jest.advanceTimersByTime(600));
const open = async () => {
  await act(async () => browse.useBrowse.setState({ sheet: "spaces" }));
  await settle();
};

onIos("on iPhone Spaces opens in the system's own sheet with main's corner radius and no grabber, never in the sheet we slide by transform", async () => {
  withProfiles([profile("work", "Work"), profile("home", "Home")]);
  const root = renderSurface(<Surfaces />);
  expect(presented(root).props.isPresented).toBe(false);
  await open();
  expect(presented(root).props.isPresented).toBe(true);
  expect(hosts(root.root, (props) => props.accessibilityViewIsModal === true)).toHaveLength(0);
  const modifiers = hosts(spacesSheet(root), (props) => Array.isArray(props.modifiers)).flatMap((node) => node.props.modifiers as { $type: string; cornerRadius?: number; visibility?: string }[]);
  expect(modifiers.some((modifier) => modifier.$type === "presentationCornerRadius" && modifier.cornerRadius === 38)).toBe(true);
  expect(modifiers.some((modifier) => modifier.$type === "presentationDragIndicator" && modifier.visibility === "hidden")).toBe(true);
  await act(async () => void presented(root).props.onIsPresentedChange({ nativeEvent: { isPresented: false } }));
  expect(browse.useBrowse.getState().sheet).toBe(null);
  await settle();
  unmount(root);
});

onIos("swiping the pager to another space selects it with a tick and counts the swipe; picking from the switcher selects it without counting a swipe", async () => {
  withProfiles([profile("work", "Work"), profile("home", "Home"), profile("play", "Play")]);
  const select = jest.spyOn(syncActions, "selectProfile").mockImplementation(() => undefined);
  const tick = jest.spyOn(haptics, "selection").mockImplementation(() => undefined);
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  const root = renderSurface(<Surfaces />);
  await open();
  expect(pager(root).props.selection).toBe("work");
  await act(async () => void pager(root).props.onSelectionChange({ nativeEvent: { selection: "home" } }));
  expect(select).toHaveBeenLastCalledWith("home");
  expect(tick).toHaveBeenCalledTimes(1);
  expect(counted).toHaveBeenCalledWith("spaces_swiped");
  expect(pager(root).props.selection).toBe("home");
  const picker = hosts(spacesSheet(root), (props) => props.label === "Space" && typeof props.onSelectionChange === "function")[0]!;
  await act(async () => void picker.props.onSelectionChange({ nativeEvent: { selection: "play" } }));
  expect(select).toHaveBeenLastCalledWith("play");
  expect(counted.mock.calls.filter((call) => call[0] === "spaces_swiped")).toHaveLength(1);
  expect(pager(root).props.selection).toBe("play");
  unmount(root);
});

onIos("a device with more than nine tabs shows eight and main's Show All, which shows the rest; a space with nothing shows main's empty view", async () => {
  withProfiles([profile("work", "Work", [{ deviceId: "mac", deviceName: "MacBook Pro", kind: "mac", tabs: tabs(12) }]), profile("home", "Home")]);
  const root = renderSurface(<Surfaces />);
  await open();
  const titles = () => hosts(spacesSheet(root), (props) => typeof props.text === "string" && /^Remote \d+$/.test(props.text)).length;
  expect(titles()).toBe(8);
  const showAll = hosts(spacesSheet(root), (props) => props.text === "Show All")[0]!;
  const button = root.root.findAll((node) => typeof node.type === "string" && typeof node.props.onButtonPress === "function" && node.findAll((inner) => inner === showAll).length > 0)[0]!;
  await act(async () => void button.props.onButtonPress({ nativeEvent: {} }));
  expect(titles()).toBe(12);
  expect(hosts(spacesSheet(root), (props) => props.title === "Nothing Here Yet")).toHaveLength(1);
  unmount(root);
});

onIos("with sync off, Spaces shows main's unavailable view, whose button opens Sync With Mac", async () => {
  withProfiles([], "off");
  const root = renderSurface(<Surfaces />);
  await open();
  expect(hosts(spacesSheet(root), (props) => props.title === "Your Mac’s Spaces")).toHaveLength(1);
  expect(hosts(spacesSheet(root), (props) => props.label === "Sync With Mac")).toHaveLength(1);
  unmount(root);
});
