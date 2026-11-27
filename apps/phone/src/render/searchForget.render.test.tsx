import { ActionSheetIOS, Platform } from "react-native";
import { act } from "react-test-renderer";
import "../platform/copy";
import { DesignProvider } from "../components/ui";
import { SearchTray } from "../components/search/SearchTray";
import * as browse from "../state/browse/store";
import * as telemetry from "../state/telemetry/telemetry";
import { history } from "../state/history/store";
import { forgetSearch, presentSearch, setSearchText, useSearch } from "../state/search/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;
const onAndroid = Platform.OS === "android" ? test : test.skip;

const OTTERS = "https://duckduckgo.com/?q=otters";
const OTTERS_GOOGLE = "https://www.google.com/search?q=OTTERS";
const TAPAS = "https://duckduckgo.com/?q=tapas";

function openIdleTray() {
  withTabs(1);
  history().clear(null);
  history().record(OTTERS, "otters", "typed", null, 1_000);
  history().record(OTTERS_GOOGLE, "otters", "typed", null, 2_000);
  history().record(TAPAS, "tapas", "typed", null, 3_000);
  browse.useBrowse.setState({ surface: "start" });
  presentSearch("start", "");
  act(() => jest.runOnlyPendingTimers());
  return renderSurface(
    <DesignProvider design="original">
      <SearchTray />
    </DesignProvider>,
  );
}

const idleQueries = () => useSearch.getState().rows.flatMap((row) => (row.kind === "query" ? [row.query] : []));

function holdRow(root: ReturnType<typeof openIdleTray>, query: string) {
  const index = useSearch.getState().rows.findIndex((row) => row.kind === "query" && row.query.toLowerCase() === query);
  const row = root.root.findAll((node) => node.props.testID === `trayRow:${index}`)[0]!;
  const button = row.findAll((node) => typeof node.props.onPress === "function" && typeof node.props.onLongPress === "function")[0]!;
  act(() => button.props.onLongPress({ nativeEvent: { pageX: 100, pageY: 400 } }));
}

const menuItems = (root: ReturnType<typeof openIdleTray>) =>
  (root.root.findAll((node) => Array.isArray(node.props.items) && typeof node.props.onDismiss === "function")[0]?.props.items ?? []) as { label: string; destructive?: boolean; onPress: () => void }[];

const confirmDialog = (root: ReturnType<typeof openIdleTray>) =>
  root.root.findAll((node) => node.props.confirmation && typeof node.props.onClose === "function")[0];

describe("deleting a past search", () => {
  let counted: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  });

  afterEach(() => {
    counted.mockRestore();
    history().clear(null);
    jest.useRealTimers();
  });

  test("past searches show the history clock, and a suggestion never searched keeps the magnifier", () => {
    const root = openIdleTray();
    const leading = (index: number) =>
      root.root
        .findAll((node) => node.props.testID === `trayRow:${index}`)[0]!
        .findAll((node) => typeof node.type !== "string" && (node.props.name === "clockArrow" || node.props.name === "magnifyingglass"))
        .map((node) => node.props.name as string)[0];
    expect(useSearch.getState().rows.map((row) => row.kind === "query" && row.past)).toEqual([true, true]);
    expect([leading(0), leading(1)]).toEqual(["clockArrow", "clockArrow"]);
    act(() => useSearch.setState({ text: "otter", rows: [{ key: "q:otter facts", kind: "query", title: "otter facts", url: "https://duckduckgo.com/?q=otter+facts", query: "otter facts" }] }));
    expect(leading(0)).toBe("magnifyingglass");
    unmount(root);
  });

  onAndroid("holding a past search opens only the Cancel/Delete dialog, and only Delete deletes", () => {
    const root = openIdleTray();
    expect(idleQueries()).toEqual(["tapas", "OTTERS"]);
    holdRow(root, "otters");
    expect(menuItems(root)).toEqual([]);
    const dialog = confirmDialog(root)!;
    expect(dialog.props.confirmation.title).toBe("Delete This Search?");
    expect(dialog.props.confirmation.message).toBe("“OTTERS” will be removed from your history on this phone.");
    expect(dialog.props.confirmation.action).toBe("Delete");
    act(() => dialog.props.onClose());
    expect(confirmDialog(root)).toBeUndefined();
    expect(history().summary().map((row) => row.url)).toContain(OTTERS);
    expect(counted).not.toHaveBeenCalledWith("searches_forgotten");

    holdRow(root, "otters");
    act(() => confirmDialog(root)!.props.confirmation.run());
    expect(history().summary().map((row) => row.url)).toEqual([TAPAS]);
    expect(idleQueries()).toEqual(["tapas"]);
    expect(counted).toHaveBeenCalledWith("searches_forgotten");
    unmount(root);
  });

  onIos("on iPhone, holding a past search opens the system action sheet, and only Delete deletes", () => {
    const answers = [1, 0];
    const sheet = jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation((_options, answer) => answer(answers.shift()!));
    const root = openIdleTray();
    holdRow(root, "otters");
    expect(menuItems(root)).toEqual([]);
    expect(confirmDialog(root)).toBeUndefined();
    expect(sheet.mock.calls[0]![0]).toMatchObject({ title: "Delete This Search?", message: "“OTTERS” will be removed from your history on this iPhone.", options: ["Delete", "Cancel"], destructiveButtonIndex: 0, cancelButtonIndex: 1 });
    expect(history().summary().map((row) => row.url)).toContain(OTTERS);

    holdRow(root, "otters");
    expect(history().summary().map((row) => row.url)).toEqual([TAPAS]);
    expect(counted).toHaveBeenCalledWith("searches_forgotten");
    sheet.mockRestore();
    unmount(root);
  });

  test("deleting the search being typed keeps the typed row without the clock, and its page and completion go too", () => {
    const root = openIdleTray();
    act(() => setSearchText("tapas"));
    const typedRow = () => useSearch.getState().rows.find((row) => row.kind === "query" && row.query === "tapas");
    expect(typedRow()).toMatchObject({ past: true });
    expect(useSearch.getState().rows.some((row) => row.kind === "page" && row.url === TAPAS)).toBe(true);
    act(() => forgetSearch("tapas"));
    expect(typedRow()).toBeDefined();
    expect(typedRow()).not.toMatchObject({ past: true });
    expect(useSearch.getState().rows.some((row) => row.kind === "page" && row.url === TAPAS)).toBe(false);
    unmount(root);
  });

  test("deleting the only search on an engine drops the inline completion it gave", () => {
    withTabs(1);
    history().clear(null);
    history().record(TAPAS, "tapas", "typed", null, 3_000);
    browse.useBrowse.setState({ surface: "start" });
    presentSearch("start", "");
    act(() => jest.runOnlyPendingTimers());
    const root = renderSurface(
      <DesignProvider design="original">
        <SearchTray />
      </DesignProvider>,
    );
    act(() => setSearchText("duck"));
    expect(useSearch.getState().completion).toBe("duckgo.com");
    act(() => forgetSearch("tapas"));
    expect(useSearch.getState().completion).toBe("");
    expect(useSearch.getState().completedFor).toBe("duck");
    unmount(root);
  });

  test("a suggestion that was never searched keeps its menu and has no Delete", () => {
    const root = openIdleTray();
    act(() => useSearch.setState({ text: "otter", rows: [{ key: "q:otter facts", kind: "query", title: "otter facts", url: "https://duckduckgo.com/?q=otter+facts", query: "otter facts" }] }));
    holdRow(root, "otter facts");
    expect(menuItems(root).map((item) => item.label)).toEqual(["Search in Incognito Tab"]);
    unmount(root);
  });
});
