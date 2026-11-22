import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import { haptics } from "../state/app/haptics";
import * as browse from "../state/browse/store";
import * as syncActions from "../state/sync/actions";
import { useSync } from "../state/sync/store";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";
import { DoneButton } from "../components/settings/ExpoSettingsDone";
import { ExpoSettingsAction } from "../components/settings/ExpoSettingsParts";

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual("@ardia/phone-native");
  return { ...actual, settingsUI: { ...actual.settingsUI, chromeSurface: (params: Record<string, unknown>) => ({ $type: "ardia.chromeSurface", ...params }) } };
});

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

onIos("with sync off, Spaces shows main's unavailable view, whose button is the shared Connect to Your Mac", async () => {
  withProfiles([], "off");
  const root = renderSurface(<Surfaces />);
  await open();
  expect(hosts(spacesSheet(root), (props) => props.title === "Your Mac’s Spaces")).toHaveLength(1);
  expect(hosts(spacesSheet(root), (props) => props.label === "Connect to Your Mac")).toHaveLength(1);
  const actions = spacesSheet(root).findAll((node) => node.type === ExpoSettingsAction);
  expect(actions.map((action) => action.props.title)).toEqual(["Connect to Your Mac"]);
  expect(actions[0]!.props.size).toBe("compact");
  unmount(root);
});

onIos("with sync on and nothing from the Mac yet, Spaces shows the shared loading state and names the destination Sync With Mac, never Sync Settings", async () => {
  withProfiles([], "updating");
  const root = renderSurface(<Surfaces />);
  await open();
  expect(hosts(spacesSheet(root), (props) => props.text === "Waiting for your Mac…")).toHaveLength(1);
  expect(hosts(spacesSheet(root), (props) => props.label === "Sync With Mac")).toHaveLength(1);
  expect(hosts(spacesSheet(root), (props) => props.label === "Sync Settings")).toHaveLength(0);
  unmount(root);
});

onIos("the header's Archive and Done faces and the page dots are rounded rectangles, and Done dismisses as the other sheets' Done does", async () => {
  withProfiles([profile("work", "Work"), profile("home", "Home")]);
  const root = renderSurface(<Surfaces />);
  await open();
  const surfaces = hosts(spacesSheet(root), (props) => Array.isArray(props.modifiers)).flatMap((node) => (node.props.modifiers as { $type: string; shape?: string }[]).filter((modifier) => modifier.$type === "ardia.chromeSurface"));
  expect(surfaces).toHaveLength(2);
  expect(surfaces.every((modifier) => modifier.shape === "rounded")).toBe(true);
  const dots = spacesSheet(root).findAll((node) => node.props.count === 2 && Array.isArray(node.props.modifiers))[0]!;
  expect((dots.props.modifiers as { $type: string; shape?: string }[]).filter((modifier) => modifier.$type === "ardia.chromeSurface")).toEqual([expect.objectContaining({ shape: "rounded" })]);
  expect(hosts(spacesSheet(root), (props) => props.label === "Close" || props.symbol === "xmark")).toHaveLength(0);
  const labelled = (label: string) => hosts(spacesSheet(root), (props) => Array.isArray(props.modifiers) && (props.modifiers as { $type: string; label?: string }[]).some((modifier) => modifier.$type === "accessibilityLabel" && modifier.label === label))[0]!;
  expect(labelled("Archive")).toBeDefined();
  const done = spacesSheet(root).findAll((node) => node.type === DoneButton);
  expect(done).toHaveLength(1);
  const doneButton = hosts(done[0]!, (props) => props.label === "Done")[0]!;
  expect((doneButton.props.modifiers as { $type: string }[]).map((modifier) => modifier.$type)).toEqual(expect.arrayContaining(["font", "tint", "ardia.chromeSurface"]));
  await act(async () => void doneButton.props.onButtonPress({ nativeEvent: {} }));
  expect(browse.useBrowse.getState().sheet).toBe(null);
  await settle();
  unmount(root);
});

onIos("a remote tab row opens with the same tick as Archive and History rows, and its menu copies with the link glyph and shares without an ellipsis", async () => {
  withProfiles([profile("work", "Work", [{ deviceId: "mac", deviceName: "MacBook Pro", kind: "mac", tabs: tabs(2) }])]);
  const go = jest.spyOn(syncActions, "openRemote").mockImplementation(() => undefined as never);
  const tick = jest.spyOn(haptics, "selection").mockImplementation(() => undefined);
  const root = renderSurface(<Surfaces />);
  await open();
  const title = hosts(spacesSheet(root), (props) => props.text === "Remote 1")[0]!;
  let button: ReactTestInstance | null = title;
  while (button && typeof button.props.onButtonPress !== "function") button = button.parent;
  await act(async () => void button!.props.onButtonPress({ nativeEvent: {} }));
  expect(go).toHaveBeenCalledWith("https://remote1.example/", "Remote 1", "work", null);
  expect(tick).toHaveBeenCalledTimes(1);
  expect(hosts(spacesSheet(root), (props) => props.label === "Copy Link").every((node) => node.props.systemImage === "link")).toBe(true);
  expect(hosts(spacesSheet(root), (props) => props.title === "Share…" || props.label === "Share…")).toHaveLength(0);
  unmount(root);
});
