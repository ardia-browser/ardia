import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import * as browse from "../state/browse/store";
import * as tabMenus from "../state/browse/tabMenus";
import * as tabsStore from "../state/tabs/store";
import { useTabs } from "../state/tabs/store";
import { renderSurface, someTabs, unmount, withTabs } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;

const archived = () => someTabs(3).map((tab, index) => ({ ...tab, id: `a${index}`, title: `Archived ${index}`, archivedAt: 1_790_000_000_000 + index * 60_000 }));

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  jest.spyOn(tabsStore, "loadArchive").mockImplementation(() => undefined);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const hosts = (node: ReactTestInstance, has: (props: Record<string, unknown>) => boolean) => node.findAll((inner) => typeof inner.type === "string" && has(inner.props));
const archiveSheet = (root: Root) => hosts(root.root, (props) => props.testID === "expoArchiveSheet")[0]!;
const presented = (root: Root) => hosts(archiveSheet(root), (props) => typeof props.isPresented === "boolean")[0]!;
const press = async (node: ReactTestInstance) => act(async () => void (node.props.onButtonPress ?? node.props.onPress)({ nativeEvent: {} }));
const settle = async () => act(async () => void jest.advanceTimersByTime(600));

onIos("on iPhone the Archive opens in the system's own sheet, as main's does, with main's title, search, Done and options, never in the sheet we slide by transform", async () => {
  useTabs.setState({ archive: archived() });
  const root = renderSurface(<Surfaces />);
  expect(presented(root).props.isPresented).toBe(false);
  await act(async () => browse.useBrowse.setState({ sheet: "archive" }));
  await settle();
  expect(presented(root).props.isPresented).toBe(true);
  expect(hosts(root.root, (props) => props.accessibilityViewIsModal === true)).toHaveLength(0);
  const sheet = archiveSheet(root);
  expect(hosts(sheet, (props) => Array.isArray(props.modifiers) && (props.modifiers as { $type: string; title?: string }[]).some((modifier) => modifier.$type === "navigationTitle" && modifier.title === "Archive"))).not.toHaveLength(0);
  expect(hosts(sheet, (props) => Array.isArray(props.modifiers) && (props.modifiers as { $type: string }[]).some((modifier) => modifier.$type === "searchable"))).not.toHaveLength(0);
  expect(hosts(sheet, (props) => props.label === "Options")).toHaveLength(1);
  await press(hosts(sheet, (props) => props.label === "Done")[0]!);
  expect(browse.useBrowse.getState().sheet).toBe(null);
  await settle();
  unmount(root);
});

onIos("Delete All asks main's question and clears; with nothing archived the sheet shows main's empty view", async () => {
  const clear = jest.spyOn(tabsStore, "clearArchivedTabs").mockImplementation(() => undefined);
  useTabs.setState({ archive: archived() });
  const root = renderSurface(<Surfaces />);
  await act(async () => browse.useBrowse.setState({ sheet: "archive" }));
  await settle();
  expect(hosts(archiveSheet(root), (props) => props.title === "Delete All Archived Tabs?")).toHaveLength(1);
  await press(hosts(archiveSheet(root), (props) => props.label === "Delete All")[0]!);
  expect(clear).toHaveBeenCalledTimes(1);
  await act(async () => useTabs.setState({ archive: [] }));
  expect(hosts(archiveSheet(root), (props) => props.title === "No Archived Tabs")).toHaveLength(1);
  await settle();
  unmount(root);
});

onIos("a row reopens its tab, and main's swipe deletes it", async () => {
  const open = jest.spyOn(tabMenus, "openArchivedTab").mockImplementation(() => undefined as never);
  const remove = jest.spyOn(tabMenus, "deleteArchivedTab").mockImplementation(() => undefined as never);
  useTabs.setState({ archive: archived() });
  const root = renderSurface(<Surfaces />);
  await act(async () => browse.useBrowse.setState({ sheet: "archive" }));
  await settle();
  const rows = hosts(archiveSheet(root), (props) => typeof props.onDelete === "function");
  expect(rows.length).toBeGreaterThan(0);
  await act(async () => rows[0]!.props.onDelete({ nativeEvent: { indices: [0], revision: rows[0]!.props.revision } }));
  expect(remove).toHaveBeenCalledTimes(1);
  const title = hosts(archiveSheet(root), (props) => props.text === "Archived 2")[0]!;
  let button: ReactTestInstance | null = title;
  while (button && !(typeof button.type === "string" && (typeof button.props.onButtonPress === "function" || typeof button.props.onPress === "function"))) button = button.parent;
  await press(button!);
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }));
  await settle();
  unmount(root);
});
