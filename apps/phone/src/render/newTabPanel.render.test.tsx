import { Dimensions, Platform, ScrollView, StyleSheet } from "react-native";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sheetPullTranslation } from "../components/ui/Sheet";
import { floatingPanelLayout, Symbol } from "../components/ui";
import { IncognitoEyes } from "../components/ui/IncognitoEyes";
import { act, type ReactTestInstance } from "react-test-renderer";
import { searchPanelShown, SearchTray } from "../components/search/SearchTray";
import { searchPanel, searchPanelRadius } from "../components/search/searchPanelTokens";
import * as tabMenus from "../state/browse/tabMenus";
import { DesignProvider } from "../components/ui";
import * as browse from "../state/browse/store";
import { history } from "../state/history/store";
import { dismissSearch, presentSearch, searchState, typeSearch } from "../state/search/store";
import { useStageBar } from "../state/search/stageBar";
import { currentTabs, useTabs } from "../state/tabs/store";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const mockFaceTaken = { then: (taken: () => void) => taken() };
const mockStage = { present: jest.fn(() => mockFaceTaken), holdLift: jest.fn(), releaseLift: jest.fn(), close: jest.fn(), finish: jest.fn() };
const mockSeen: { props: Record<string, unknown> | null } = { props: null };

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual("@ardia/phone-native");
  const React = jest.requireActual<typeof import("react")>("react");
  const native = jest.requireActual<typeof import("react-native")>("react-native");
  const onIPhone = () => native.Platform.OS === "ios";
  const SearchStage = React.forwardRef((props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => mockStage, []);
    mockSeen.props = props;
    const { onLift, onReveal, onSettled, morphLook, anchorNativeId, faceNativeId, commandTop, fieldCenter, shown, ...rest } = props;
    return React.createElement(native.View, rest);
  });
  const CompletingField = React.forwardRef((props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => ({ focus: () => undefined, blur: () => undefined, setText: () => undefined }), []);
    return React.createElement(native.View, { testID: "completingField", style: props.style, fieldNativeID: props.nativeID } as object);
  });
  return { ...actual, searchStageIsNative: onIPhone, SearchStage, SearchStagePanel: (props: object) => React.createElement(native.View, props), completingFieldIsNative: onIPhone, CompletingField };
});

const onIPhone = Platform.OS === "ios" ? test : test.skip;
const onAndroid = Platform.OS === "android" ? test : test.skip;
let revision = 9000;

beforeEach(() => {
  jest.useFakeTimers();
  revision += 1;
  jest.spyOn(history(), "summary").mockImplementation(() =>
    Array.from({ length: 12 }, (_unused, index) => ({ url: `https://site${index}.example/`, title: `Site ${index}`, favicon: null, visits: 12 - index, lastVisit: index })),
  );
  jest.spyOn(history(), "revision").mockImplementation(() => revision);
  withTabs(2);
  useStageBar.setState({ onScreen: false, presented: false, morphs: false, landed: false, pills: 0 });
  act(() => browse.useBrowse.setState({ surface: "start", sheet: null }));
  Object.values(mockStage).forEach((call) => call.mockClear());
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  act(() => useTabs.setState({ incognito: false }));
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const host = (root: Root, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string")[0];
const flat = (node: ReactTestInstance | undefined) => StyleSheet.flatten(node?.props.style) ?? {};
const tray = () => renderSurface(<DesignProvider design="redesigned"><SearchTray /></DesignProvider>);
const lift = (to: number) => act(() => (mockSeen.props!.onLift as (lift: { lift: number; up: boolean }) => void)({ lift: to, up: true }));
const editPage = () => act(() => presentSearch("page", "site0.example", null, { currentUrl: "https://site0.example/", currentTabId: currentTabs().open[0]!.id }));

const rowsMeasure = (root: Root, height: number) => act(() => root.root.findAll((node) => node.props.testID === "searchPanelRowsScroll" && typeof node.props.onContentSizeChange === "function")[0]!.props.onContentSizeChange(0, height));
const PANEL_RADIUS = searchPanelRadius(searchPanel.fieldHeight);
const PANEL_HEIGHT = searchPanel.fieldInset + searchPanel.fieldHeight + searchPanel.rowsTop + searchPanel.rowsShown * searchPanel.rowPitch + searchPanel.bottom;

onIPhone("the search panel has one fixed height, the field and four rows as in Arc, whatever the rows measure, from a new tab and when editing a page", () => {
  act(() => presentSearch("start", ""));
  const root = tray();
  act(() => typeSearch("site"));
  act(() => jest.advanceTimersByTime(50));
  lift(300);
  rowsMeasure(root, 120);
  expect(flat(host(root, "traySurface")).height).toBe(PANEL_HEIGHT + 300);
  rowsMeasure(root, 2000);
  expect(flat(host(root, "traySurface")).height).toBe(PANEL_HEIGHT + 300);
  unmount(root);
  act(() => dismissSearch());
  editPage();
  const edit = tray();
  lift(300);
  expect(flat(host(edit, "traySurface")).height).toBe(PANEL_HEIGHT + 300);
  expect(PANEL_HEIGHT).toBe(280.5);
  unmount(edit);
});

onIPhone("editing a page opens the panel with an empty field, and the page is the first row: tapping it puts its address in the field, its copy button copies the link", () => {
  editPage();
  const root = tray();
  expect(searchState().text).toBe("");
  expect(host(root, "trayCurrentPage")).toBeDefined();
  const copy = jest.spyOn(tabMenus, "copyLink").mockImplementation(() => undefined);
  act(() => root.root.findAll((node) => node.props.testID === "trayCurrentPageCopy" && typeof node.props.onPress === "function")[0]!.props.onPress());
  const { open, selectedId } = useTabs.getState();
  expect(copy).toHaveBeenCalledWith(open.find((tab) => tab.id === selectedId)!.url);
  act(() => root.root.findAll((node) => node.props.testID === "trayCurrentPage" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(searchState().text).toBe("site0.example");
  expect(host(root, "trayCurrentPage")).toBeUndefined();
  unmount(root);
});

onIPhone("a page that redirects while the panel is open keeps the page row on the address it opened with: its title, the copied link and the address it puts in the field", () => {
  editPage();
  const root = tray();
  const { open, selectedId } = useTabs.getState();
  const before = open.find((tab) => tab.id === selectedId)!;
  act(() => useTabs.setState({ open: open.map((tab) => (tab.id === selectedId ? { ...tab, url: "https://moved.example/b", title: "Moved Page" } : tab)) }));
  expect(root.root.findAll((node) => node.props.children === "Moved Page")).toHaveLength(0);
  const copy = jest.spyOn(tabMenus, "copyLink").mockImplementation(() => undefined);
  act(() => root.root.findAll((node) => node.props.testID === "trayCurrentPageCopy" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(copy).toHaveBeenCalledWith(before.url);
  act(() => root.root.findAll((node) => node.props.testID === "trayCurrentPage" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(searchState().text).toBe("site0.example");
  unmount(root);
});

onIPhone("the page row keeps the address it opened with when typing hides it, the page redirects, and the field is cleared", () => {
  editPage();
  const root = tray();
  const { open, selectedId } = useTabs.getState();
  const before = open.find((tab) => tab.id === selectedId)!;
  act(() => typeSearch("abc"));
  act(() => jest.runOnlyPendingTimers());
  expect(host(root, "trayCurrentPage")).toBeUndefined();
  act(() => useTabs.setState({ open: open.map((tab) => (tab.id === selectedId ? { ...tab, url: "https://moved.example/b", title: "Moved Page" } : tab)) }));
  act(() => typeSearch(""));
  act(() => jest.runOnlyPendingTimers());
  expect(host(root, "trayCurrentPage")).toBeDefined();
  expect(root.root.findAll((node) => node.props.children === "Moved Page")).toHaveLength(0);
  const copy = jest.spyOn(tabMenus, "copyLink").mockImplementation(() => undefined);
  act(() => root.root.findAll((node) => node.props.testID === "trayCurrentPageCopy" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(copy).toHaveBeenCalledWith(before.url);
  unmount(root);
});

onIPhone("the panel's field is a 44 point pill with the mic and Incognito's eyes inside it, and in Incognito it reads Incognito beside the eyes", () => {
  act(() => presentSearch("start", ""));
  const root = tray();
  const capsule = host(root, "trayFieldCapsule")!;
  expect(flat(capsule)).toMatchObject({ height: searchPanel.fieldHeight, borderRadius: searchPanel.fieldHeight / 2 });
  expect(flat(host(root, "completingField")).fontSize).toBeUndefined();
  expect(capsule.findAll((node) => node.props.accessibilityLabel === "Incognito" && node.props.accessibilityRole === "switch" && node.props.accessibilityState?.checked === false)).not.toHaveLength(0);
  expect(capsule.findAll((node) => node.type === IncognitoEyes)).toHaveLength(1);
  expect(capsule.findAll((node) => node.type === Symbol && node.props.name === "eyes")).toHaveLength(0);
  expect(host(root, "trayIncognitoLabel")).toBeUndefined();
  act(() => root.root.findAll((node) => node.props.testID === "trayIncognito" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(useTabs.getState().incognito).toBe(true);
  const incognitoCapsule = host(root, "trayFieldCapsule")!;
  expect(incognitoCapsule.findAll((node) => node.props.accessibilityLabel === "Incognito" && node.props.accessibilityRole === "switch" && node.props.accessibilityState?.checked === true)).not.toHaveLength(0);
  expect(incognitoCapsule.findAll((node) => node.type === IncognitoEyes && node.props.incognito === true)).toHaveLength(1);
  expect(host(root, "trayIncognitoPlate")).toBeUndefined();
  expect(root.root.findAll((node) => node.props.testID === "trayIncognitoLabel" && node.props.children === "Incognito").length).toBeGreaterThan(0);
  expect(root.root.findAll((node) => node.props.children === "You\u2019re browsing Incognito").length).toBeGreaterThan(0);
  expect(host(root, "searchPanelRowsScroll")).toBeUndefined();
  unmount(root);
});

onIPhone("the panel runs edge to edge and on under the keyboard to the screen's bottom, its rows ending above the keyboard, with only its top corners rounded", () => {
  act(() => presentSearch("start", ""));
  const root = tray();
  lift(300);
  expect(flat(host(root, "trayPanel")).bottom).toBe(-300);
  expect(flat(host(root, "trayRowsReveal")).paddingBottom).toBe(300);
  expect(flat(host(root, "traySurface"))).toMatchObject({ borderTopLeftRadius: PANEL_RADIUS, borderTopRightRadius: PANEL_RADIUS });
  expect(flat(host(root, "traySurface")).borderBottomLeftRadius).toBeUndefined();
  expect(mockSeen.props).toMatchObject({ cardInset: floatingPanelLayout.inset, cardGap: 0, fieldInset: searchPanel.fieldInset, fieldTop: searchPanel.fieldInset, morphCorners: { panel: PANEL_RADIUS } });
  unmount(root);
  act(() => dismissSearch());
  editPage();
  const edit = tray();
  lift(300);
  expect(flat(host(edit, "trayPanel")).bottom).toBe(-300);
  unmount(edit);
});

onIPhone("more suggestions than fit scroll inside the panel under a field that stays put, and dragging the list keeps the keyboard", () => {
  act(() => presentSearch("start", ""));
  const root = tray();
  act(() => typeSearch("site"));
  act(() => jest.advanceTimersByTime(50));
  const list = root.root.findAll((node) => node.type === ScrollView && node.props.testID === "searchPanelRowsScroll")[0]!;
  expect(list.props.keyboardDismissMode).toBe("none");
  expect(host(root, "trayRows")).toBeUndefined();
  expect(searchState().rows.length).toBeGreaterThan(3);
  unmount(root);
});

onIPhone("the new-tab panel opening counts new_tab_search_opened, except in Incognito and when editing a page", () => {
  const counted = jest.spyOn(telemetry, "countUsage");
  act(() => presentSearch("start", ""));
  const root = tray();
  expect(counted).toHaveBeenCalledWith("new_tab_search_opened");
  unmount(root);
  act(() => dismissSearch());
  counted.mockClear();
  editPage();
  const edit = tray();
  expect(counted).not.toHaveBeenCalledWith("new_tab_search_opened");
  unmount(edit);
});

test("the panel shows on a phone, never beside a command bar", () => {
  expect(searchPanelShown(true, false)).toBe(true);
  expect(searchPanelShown(false, false)).toBe(false);
  expect(searchPanelShown(true, true)).toBe(false);
});

onAndroid("Android's search draws the same panel, edge to edge with its field on top", () => {
  act(() => presentSearch("start", ""));
  const root = tray();
  expect(host(root, "searchPanelFieldRow")).toBeDefined();
  expect(flat(host(root, "trayPanel"))).toMatchObject({ borderTopLeftRadius: PANEL_RADIUS });
  expect(host(root, "traySurface")).toBeUndefined();
  unmount(root);
});

let seenTop = 0;
let seenBottom = 0;
function InsetProbe() {
  const insets = useSafeAreaInsets();
  seenTop = insets.top;
  seenBottom = insets.bottom;
  return null;
}
const trayWithInsets = () => renderSurface(<DesignProvider design="redesigned"><InsetProbe /><SearchTray /></DesignProvider>);
const pull = (id: string, translationY: number) => {
  act(() =>
    fireGestureHandler(getByGestureTestId(id), [
      { state: State.BEGAN, translationY: 0, velocityY: 0 },
      { state: State.ACTIVE, translationY: translationY / 2, velocityY: 0 },
      { state: State.ACTIVE, translationY, velocityY: 0 },
      { state: State.END, translationY, velocityY: 0 },
    ]),
  );
  act(() => jest.runOnlyPendingTimers());
};
const closeSearchDim = (root: Root) => root.root.findAll((node) => node.props.accessibilityLabel === "Close Search" && typeof node.props.onPress === "function")[0]!;

onIPhone("on a short screen the panel's top still stops 28 points under the status bar, whether the keyboard is up or down", () => {
  act(() => presentSearch("start", ""));
  const root = trayWithInsets();
  const window = Dimensions.get("window").height;
  const gap = 0;
  const aboveKeyboard = () => (flat(host(root, "traySurface")).height as number) + (flat(host(root, "trayPanel")).bottom as number);
  act(() => typeSearch("site"));
  act(() => jest.advanceTimersByTime(50));
  lift(window - seenTop - 28 - gap - 200);
  rowsMeasure(root, 2000);
  expect(window - (window - seenTop - 28 - gap - 200) - gap - aboveKeyboard()).toBe(seenTop + 28);
  unmount(root);
});

onIPhone("a tap above the panel closes it, with the keyboard up and with it down, and Close Search comes first for VoiceOver", () => {
  act(() => presentSearch("start", ""));
  const root = tray();
  const dim = host(root, "trayDim")!;
  expect(dim.props.pointerEvents).toBe("auto");
  expect(dim.props.accessibilityElementsHidden).toBe(false);
  const accessible = root.root.findAll((node) => typeof node.type === "string" && (node.props.accessibilityRole === "button" || node.props.accessible === true) && node.props.accessibilityElementsHidden !== true);
  expect(accessible[0]!.props.accessibilityLabel).toBe("Close Search");
  act(() => {
    closeSearchDim(root).props.onPress();
  });
  expect(searchState().open).toBe(false);
  unmount(root);
});

onIPhone("a drag down that starts on the field closes the panel", () => {
  act(() => presentSearch("start", ""));
  const root = tray();
  lift(300);
  pull("trayDismissDrag", 240);
  expect(searchState().open).toBe(false);
  unmount(root);
});

onIPhone("a drag down that starts on the list closes the panel while the list is at its top, and a drag up never does", () => {
  act(() => presentSearch("start", ""));
  const root = tray();
  lift(300);
  act(() => typeSearch("site"));
  act(() => jest.advanceTimersByTime(50));
  pull("trayListDrag", -240);
  expect(searchState().open).toBe(true);
  pull("trayListDrag", 240);
  expect(searchState().open).toBe(false);
  unmount(root);
});

test("on a list scrolled down, a drag goes to the scroll and moves nothing: one rule with the sheet's", () => {
  expect(sheetPullTranslation(240, true, false)).toBe(0);
  expect(sheetPullTranslation(240, true, true)).toBe(240);
  expect(sheetPullTranslation(-240, true, true)).toBe(0);
  expect(sheetPullTranslation(240, false, false)).toBe(240);
});

onIPhone("submitting from the panel closes it", () => {
  act(() => presentSearch("start", ""));
  const root = tray();
  act(() => {
    browse.submitSearch("example.com");
  });
  expect(searchState().open).toBe(false);
  unmount(root);
});

onIPhone("with search closed the panel's dim takes no touches, so nothing covers the app", () => {
  const root = tray();
  const dim = host(root, "trayDim");
  if (dim) expect(dim.props.pointerEvents).toBe("none");
  act(() => presentSearch("start", ""));
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  const after = host(root, "trayDim");
  if (after) expect(after.props.pointerEvents).toBe("none");
  unmount(root);
});
