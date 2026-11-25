import { predictiveBack, type PredictiveBackHandlers } from "@ardia/phone-native";
import { Keyboard, Platform } from "react-native";
import { Pressable } from "react-native-gesture-handler";
import { act } from "react-test-renderer";
import { Surfaces } from "../App";
import { pages } from "../platform/pages";
import { useBrowse } from "../state/browse/store";
import { usePageUi } from "../state/page/store";
import { pageMenuHidden, showDockedFind } from "../state/page/actions";
import { useSearch } from "../state/search/store";
import { useTabs } from "../state/tabs/store";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, someTabs, unmount, withTabs, withMaterialYou } from "../../test/render/harness";

withMaterialYou();

const onAndroid = Platform.OS === "android" ? test : test.skip;
const claims: PredictiveBackHandlers[] = [];
type Root = ReturnType<typeof renderSurface>;
const hosts = (root: Root, id: string) => root.root.findAll((node) => typeof node.type === "string" && node.props.testID === id);
const press = (root: Root, id: string) => root.root.findAll((node) => node.type === Pressable && node.props.testID === id)[0]!.props.onPress();
const settle = () => {
  for (let frame = 0; frame < 60; frame++) act(() => jest.advanceTimersByTime(16));
};

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null, veiled: null, covered: null });
  useSearch.setState({ open: false });
  usePageUi.setState({ menuOpen: false, menuDocked: false, findOpen: false, findQuery: "", readerTabId: null, press: null });
  claims.length = 0;
  jest.spyOn(pages, "listsSitePermissions").mockReturnValue(false);
  jest.spyOn(predictiveBack, "isNative").mockReturnValue(true);
  jest.spyOn(predictiveBack, "claim").mockImplementation((handlers) => {
    claims.push(handlers);
    return { remove: () => void claims.splice(claims.indexOf(handlers), 1) };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

onAndroid.each(["close", "back", "keyboard"])("Find dismissed by %s restores More and accepts the next sheet action", async (method) => {
  const listeners = new Set<() => void>();
  const addListener = Keyboard.addListener.bind(Keyboard);
  jest.spyOn(Keyboard, "addListener").mockImplementation((name, listener) => {
    if (name !== "keyboardDidHide") return addListener(name, listener);
    const hidden = () => listener({} as never);
    listeners.add(hidden);
    return { remove: () => void listeners.delete(hidden) };
  });
  const counted = jest.spyOn(telemetry, "countUsage");
  const root = renderSurface(<Surfaces />);
  try {
    for (let round = 0; round < 2; round++) {
      await act(async () => { await press(root, "materialBarSiteSettings"); });
      settle();
      act(() => press(root, "pageMenuRow:Find on Page"));
      settle();
      expect(usePageUi.getState().findOpen).toBe(true);
      expect(hosts(root, "materialSheet")).toHaveLength(0);
      expect(hosts(root, "materialFindBar")).toHaveLength(1);
      act(() => {
        if (method === "close") root.root.findAll((node) => node.type === Pressable && node.props.accessibilityLabel === "Close Find")[0]!.props.onPress();
        else if (method === "back") claims.at(-1)!.onCommit?.();
        else for (const listener of listeners) listener();
      });
      expect(usePageUi.getState().findOpen).toBe(false);
      expect(usePageUi.getState().findQuery).toBe("");
      expect(counted.mock.calls.filter(([field]) => field === "find_closed_bar")).toHaveLength(round + 1);
      expect(hosts(root, "materialFindBar")).toHaveLength(0);
      expect(hosts(root, "materialBottomBar")[0]!.props.pointerEvents).toBe("auto");
      await act(async () => { await press(root, "materialBarSiteSettings"); });
      settle();
      act(() => press(root, "pageMenuRow:Site Settings"));
      expect(usePageUi.getState().menuPage).toBe("siteSettings");
      act(() => claims.at(-1)!.onCommit?.());
      expect(usePageUi.getState().menuPage).toBe("main");
      act(() => claims.at(-1)!.onCommit?.());
      settle();
      expect(hosts(root, "materialSheet")).toHaveLength(0);
    }
  } finally {
    unmount(root);
  }
  expect(claims).toHaveLength(0);
});

onAndroid.each([true, false])("closing Find after switching tabs uses the original session privacy: private=%s", (isPrivate) => {
  const normal = someTabs(1)[0]!;
  const privateTab = someTabs(1, true)[0]!;
  useTabs.setState({ open: [normal], privates: [privateTab], selectedId: isPrivate ? privateTab.id : normal.id });
  const counted = jest.spyOn(telemetry, "countUsage");
  act(() => {
    showDockedFind();
    pageMenuHidden();
  });
  expect(usePageUi.getState().findOpen).toBe(true);
  act(() => useTabs.setState({ selectedId: isPrivate ? normal.id : privateTab.id }));
  expect(usePageUi.getState().findOpen).toBe(false);
  expect(counted.mock.calls.filter(([field]) => field === "find_closed_bar")).toHaveLength(isPrivate ? 0 : 1);
});
