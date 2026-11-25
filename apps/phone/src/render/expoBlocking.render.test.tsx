import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { SettingsView } from "../components/settings/SettingsView";
import * as settingsActions from "../state/settings/actions";
import { useBlocking } from "../state/settings/actions";
import { openSettings, settingsNav } from "../state/settings/nav";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;

const list = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `List ${id}`,
  group: "Ads",
  category: "ads",
  sourceUrl: null,
  supportUrl: null,
  languages: [],
  isEnabled: true,
  isDefault: true,
  isCustom: false,
  ruleCount: 1200,
  skippedCount: 0,
  updatedAt: 1,
  state,
  failure: null,
  ...extra,
});

const withLists = (exemptHosts: string[] = []) =>
  useBlocking.setState({
    busy: false,
    state: {
      isEnabled: true,
      blocksAds: true,
      blocksTrackers: true,
      hidesCookieBanners: true,
      exemptHosts,
      status: "ready",
      failure: null,
      isUpdating: false,
      isOffline: false,
      lastUpdated: 1,
      enabledRuleCount: 2400,
      buildError: null,
      myFilters: "",
      myFiltersRuleCount: 0,
      lists: [list("a", "ready"), list("b", "downloading"), list("c", "failed", { isCustom: true, isDefault: false, failure: "Couldn’t reach the list.", sourceUrl: "https://example.com/c.txt" })],
    } as never,
  });

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  withLists();
  jest.spyOn(settingsActions, "refreshSettings").mockResolvedValue(undefined as never);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const destination = (root: Root, value: string) => root.root.findAll((node) => typeof node.type === "string" && node.props.name === "destination" && (node.props.extraProps as { value?: string } | undefined)?.value === value)[0]!;
const within = (node: ReactTestInstance, has: (props: Record<string, unknown>) => boolean) => node.findAll((inner) => typeof inner.type === "string" && has(inner.props));
const texts = (node: ReactTestInstance) => within(node, (props) => typeof props.text === "string").map((inner) => inner.props.text as string);
const press = async (node: ReactTestInstance) => act(async () => void (node.props.onButtonPress ?? node.props.onPress)({ nativeEvent: {} }));

onIos("on iPhone Filter Lists is main's page on Expo UI: lists by group with a switch each, Update Now, Add a List in main's medium sheet, My Filters, and Restore Defaults behind a confirmation", async () => {
  const update = jest.spyOn(settingsActions, "updateListsFromButton").mockResolvedValue(undefined);
  const enable = jest.spyOn(settingsActions, "setListEnabled").mockResolvedValue(undefined as never);
  openSettings({ page: "filterLists" });
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const page = () => destination(root, "filterLists");
  expect(texts(page())).toEqual(expect.arrayContaining(["Filter Lists", "Update Now", "List a", "List b", "List c", "Checked weekly."]));
  await press(within(page(), (props) => typeof props.onButtonPress === "function" || typeof props.onPress === "function").find((node) => texts(node).includes("Update Now"))!);
  expect(update).toHaveBeenCalledTimes(1);
  const switches = within(page(), (props) => typeof props.isOn === "boolean");
  expect(switches).toHaveLength(3);
  await act(async () => switches[0]!.props.onIsOnChange({ nativeEvent: { isOn: false } }));
  expect(enable).toHaveBeenCalledWith("a", false);
  const addSheet = () => within(page(), (props) => typeof props.isPresented === "boolean").find((node) => within(node, (inner) => inner.label === "Add a List…").length > 0)!;
  expect(addSheet().props.isPresented).toBe(false);
  await press(within(addSheet(), (props) => props.label === "Add a List…")[0]!);
  expect(addSheet().props.isPresented).toBe(true);
  const sheetGroup = within(addSheet(), (props) => Array.isArray(props.modifiers) && (props.modifiers as { $type: string }[]).some((modifier) => modifier.$type === "presentationDetents"))[0]!;
  expect((sheetGroup.props.modifiers as { $type: string; detents?: unknown }[]).find((modifier) => modifier.$type === "presentationDetents")?.detents).toEqual(["medium", "large"]);
  expect(within(page(), (props) => props.label === "Restore Defaults")).toHaveLength(1);
  unmount(root);
});

onIos("a list's page has Use This List, the failure with Try Again, main's status rows, its source, and Remove List for a list you added", async () => {
  const remove = jest.spyOn(settingsActions, "removeList").mockResolvedValue(undefined as never);
  openSettings({ page: "filterList", id: "c" } as never);
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const page = destination(root, "filterList:c");
  expect(texts(page)).toEqual(expect.arrayContaining(["Use This List", "https://example.com/c.txt", "You can add it again later."]));
  expect(within(page, (props) => props.title === "Couldn’t reach the list.")).toHaveLength(1);
  expect(within(page, (props) => typeof props.label === "string").map((node) => node.props.label)).toEqual(expect.arrayContaining(["Status", "Last Updated", "Rules", "Skipped", "Try Again", "Remove List…", "Remove List"]));
  await press(within(page, (props) => props.label === "Remove List")[0]!);
  expect(remove).toHaveBeenCalledWith("c");
  unmount(root);
});

onIos("Trusted Sites lists each host with main's swipe to delete and an Edit button; with none it shows main's empty view", async () => {
  const trust = jest.spyOn(settingsActions, "trustSite").mockResolvedValue(undefined as never);
  withLists(["b.example", "a.example"]);
  openSettings({ page: "trustedSites" });
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const page = destination(root, "trustedSites");
  expect(within(page, (props) => typeof props.title === "string").map((node) => node.props.title)).toEqual(expect.arrayContaining(["a.example", "b.example"]));
  const rows = within(page, (props) => typeof props.onDelete === "function")[0]!;
  await act(async () => rows.props.onDelete({ nativeEvent: { indices: [0] } }));
  expect(trust).toHaveBeenCalledWith("a.example", false);
  expect(within(page, (props) => props.label === "Edit")).toHaveLength(1);
  unmount(root);
  withLists([]);
  openSettings({ page: "trustedSites" });
  const empty = renderSurface(<SettingsView />);
  await act(async () => undefined);
  expect(within(destination(empty, "trustedSites"), (props) => props.title === "No Trusted Sites")).toHaveLength(1);
  unmount(empty);
});
