import { Dimensions, Platform, StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { SearchTray, searchPanelMorphLook, searchPanelSolidFace, trayThemeFor } from "../components/search/SearchTray";
import { incognitoTheme, PRIVATE_ACCENT, type Theme } from "../components/ui/theme";
import { searchFieldHeight, searchPanel, searchPanelPlace, searchPanelPlacement, searchPanelPreferredHeight, searchPanelRadius } from "../components/search/searchPanelTokens";
import { browseLayout, DesignProvider, floatingPanelLayout, iconRoles, press, Symbol } from "../components/ui";
import { nativeClassicChrome } from "../components/ui/tokens";
import { chromeIsSolid, plateMaterial, SEARCH_PANEL_FACE } from "../components/ui/LookViews";
import { PHONE_LAYOUT, useScreenLayout } from "../state/app/screenLayout";
import * as browse from "../state/browse/store";
import * as tabMenus from "../state/browse/tabMenus";
import { dismissSearch, presentSearch, typeSearch } from "../state/search/store";
import { useStageBar } from "../state/search/stageBar";
import { currentTabs, useTabs } from "../state/tabs/store";
import * as voice from "../state/voice/store";
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
    return React.createElement(native.View, { testID: "completingField", style: props.style } as object);
  });
  return { ...actual, searchStageIsNative: onIPhone, SearchStage, SearchStagePanel: (props: object) => React.createElement(native.View, props), completingFieldIsNative: onIPhone, CompletingField };
});

const onIPhone = Platform.OS === "ios" ? test : test.skip;
const realWindow = Dimensions.get("window");
const textSize = (scale: number) => Dimensions.set({ window: { ...realWindow, fontScale: scale }, screen: { ...realWindow, fontScale: scale } });

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  useStageBar.setState({ onScreen: false, presented: false, morphs: false, landed: false, pills: 0 });
  act(() => browse.useBrowse.setState({ surface: "start", sheet: null }));
  Object.values(mockStage).forEach((call) => call.mockClear());
  mockSeen.props = null;
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  act(() => useTabs.setState({ incognito: false }));
  act(() => useScreenLayout.setState({ layout: PHONE_LAYOUT }));
  textSize(realWindow.fontScale);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const host = (root: Root, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string")[0];
const flat = (node: ReactTestInstance | undefined, pressed = false) => StyleSheet.flatten(typeof node?.props.style === "function" ? node.props.style({ pressed }) : node?.props.style) ?? {};
const tray = () => renderSurface(<DesignProvider design="redesigned"><SearchTray /></DesignProvider>);
const stage = () => mockSeen.props!;
const pressable = (root: Root, label: string) => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.type === "string" && node.props.accessibilityRole !== undefined)[0]!;
const pressStyled = (root: Root, match: (node: ReactTestInstance) => boolean) => root.root.findAll((node) => match(node) && typeof node.props.style === "function")[0]!;
const editPage = () => act(() => presentSearch("page", "site0.example", null, { currentUrl: "https://site0.example/", currentTabId: currentTabs().open[0]!.id }));
const clipOf = (root: Root) => host(root, "traySurface")!.findAll((node) => typeof node.type === "string" && flat(node).overflow === "hidden")[0];

test("the panel's corner is concentric with its field: half the field's height plus the one inset around it", () => {
  expect(searchPanelRadius(searchPanel.fieldHeight)).toBe(searchPanel.fieldHeight / 2 + searchPanel.fieldInset);
  expect(searchPanelRadius(searchPanel.fieldHeight)).toBe(39.75);
  expect(searchFieldHeight(1)).toBe(searchPanel.fieldHeight);
  expect(searchFieldHeight(0.8)).toBe(searchPanel.fieldHeight);
  expect(searchFieldHeight(1.2)).toBeCloseTo(searchPanel.fieldHeight * 1.2);
  expect(searchFieldHeight(3)).toBeCloseTo(searchPanel.fieldHeight * searchPanel.maxTextScale);
});

test("one chrome rule decides solid: Classic, Reduce Transparency or no native frost draw solid, Glass with native frost draws the frost", () => {
  expect(chromeIsSolid("glass", false, true)).toBe(false);
  expect(chromeIsSolid("classic", false, true)).toBe(true);
  expect(chromeIsSolid("glass", true, true)).toBe(true);
  expect(chromeIsSolid("glass", false, false)).toBe(true);
});

test("the search field is the documented 47.5-point Search field, never shorter than its 44-point accessories and two edges, and its capsule comes from that outer height", () => {
  expect(searchPanel.fieldHeight).toBe(browseLayout.searchFieldHeight);
  expect(searchPanel.fieldHeight).toBe(47.5);
  for (const scale of [0.8, 1, 1.2, 3]) expect(searchFieldHeight(scale)).toBeGreaterThanOrEqual(searchPanel.accessorySlot + searchPanel.fieldEdge * 2);
});

test("the search panel's face and its morph follow the one plate rule: the panel asks for frost, Classic and Reduce Transparency make it solid, and only a glass face would ever use Liquid Glass", () => {
  expect(SEARCH_PANEL_FACE).toBe("frost");
  expect(plateMaterial(SEARCH_PANEL_FACE, false, true)).toBe("frost");
  expect(plateMaterial(SEARCH_PANEL_FACE, true, true)).toBe("solid");
  expect(plateMaterial("glass", false, true)).toBe("glass");
  expect(plateMaterial("glass", false, false)).toBe("frost");
  expect(plateMaterial("glass", true, true)).toBe("solid");
  expect(searchPanelMorphLook(false, false, "frost")).toMatchObject({ usesGlass: false, frosted: true, classicPanel: searchPanel.light.tint });
  expect(searchPanelMorphLook(false, false, "solid")).toMatchObject({ usesGlass: false, frosted: false, classicPanel: searchPanel.light.solid });
  expect(searchPanelMorphLook(false, false, "glass")).toMatchObject({ usesGlass: true, frosted: false });
  expect(searchPanelMorphLook(false, true, "solid").classicChrome).toBe(nativeClassicChrome);
});

test("the Incognito tray takes the private accent from incognitoTheme, the same source as Start and the deck, never the profile's", () => {
  const base = { accent: "#ff0000", formAccent: "#ff0000", spaceAccent: "#ff0000", spaceAccentInk: "#ff0000", surface: "#ffffff" } as unknown as Theme;
  const tray = trayThemeFor(base, true);
  expect(tray.accent).toBe(PRIVATE_ACCENT.spaceAccent);
  expect(tray.spaceAccentInk).toBe(PRIVATE_ACCENT.spaceAccentInk);
  expect({ ...tray, surface: undefined }).toEqual({ ...incognitoTheme(base), surface: undefined });
  expect(trayThemeFor(base, false)).toBe(base);
});

test("in Classic the resting search panel draws the same chrome edge its native morph draws, like the bars", () => {
  for (const [incognito, dark] of [[false, false], [false, true], [true, false]] as const) {
    const face = searchPanelSolidFace(incognito, dark);
    const morph = searchPanelMorphLook(incognito, dark, "solid");
    expect(face.backgroundColor).toBe(morph.classicPanel);
    expect(face.borderWidth).toBe(morph.classicChrome.edgeWidth);
    expect(face.borderColor).toBe(incognito || dark ? morph.classicChrome.edge.dynamic.dark : morph.classicChrome.edge.dynamic.light);
  }
});

test("one placement decides the panel's corners, card and keyboard gaps: the phone's panel runs on under the keyboard with side margins, its rows lined up with the field, and a floating panel sits above it", () => {
  expect(searchPanelPlacement(true, false)).toBe("underKeyboard");
  expect(searchPanelPlacement(false, false)).toBe("aboveKeyboard");
  expect(searchPanelPlacement(true, true)).toBe("commandBar");
  expect(searchPanelPlace("underKeyboard", 300)).toMatchObject({ corners: "top", cardInset: floatingPanelLayout.inset, cardGap: 0, underKeyboard: 300, gapAboveKeyboard: 0, fieldInset: searchPanel.fieldInset, fieldTop: searchPanel.fieldInset });
  expect(searchPanel.rowInset).toBe(searchPanel.fieldInset);
  expect(searchPanelPlace("aboveKeyboard", 300)).toMatchObject({ corners: "all", cardInset: floatingPanelLayout.inset, cardGap: floatingPanelLayout.aboveKeyboard, underKeyboard: 0, fieldInset: searchPanel.fieldInset });
  const fixed = searchPanelPreferredHeight("underKeyboard", searchPanel.fieldHeight, 1, 10);
  expect(searchPanelPreferredHeight("underKeyboard", searchPanel.fieldHeight, 1, 5000)).toBe(fixed);
  expect(searchPanelPreferredHeight("aboveKeyboard", searchPanel.fieldHeight, 1, 10)).toBeLessThan(fixed);
  expect(searchPanelPreferredHeight("aboveKeyboard", searchPanel.fieldHeight, 1, 5000)).toBe(fixed);
});

onIPhone("on a phone the panel, its clip, its field row and the native morph all come from the one field and inset", () => {
  act(() => presentSearch("start", ""));
  const root = tray();
  const radius = searchPanelRadius(searchPanel.fieldHeight);
  expect(flat(host(root, "traySurface"))).toMatchObject({ borderTopLeftRadius: radius, borderTopRightRadius: radius, borderCurve: "continuous" });
  expect(flat(clipOf(root))).toMatchObject({ borderTopLeftRadius: radius, borderTopRightRadius: radius });
  expect(flat(host(root, "searchPanelFieldRow"))).toMatchObject({ paddingHorizontal: searchPanel.fieldInset, paddingTop: searchPanel.fieldInset });
  expect(flat(host(root, "trayFieldCapsule"))).toMatchObject({ height: searchPanel.fieldHeight, borderRadius: searchPanel.fieldHeight / 2 });
  expect(stage()).toMatchObject({ fieldInset: searchPanel.fieldInset, fieldTop: searchPanel.fieldInset, fieldCenter: searchPanel.fieldInset + searchPanel.fieldHeight / 2, morphCorners: { panel: radius, field: searchPanel.fieldHeight / 2 } });
  unmount(root);
});

onIPhone("beside a command bar the panel keeps the same field, insets and concentric corner, on all four corners", () => {
  act(() => useScreenLayout.setState({ layout: { name: "wide" } as never }));
  act(() => presentSearch("page", ""));
  const root = tray();
  expect(stage().commandTop).not.toBeNull();
  const radius = searchPanelRadius(searchPanel.fieldHeight);
  expect(flat(host(root, "traySurface"))).toMatchObject({ borderRadius: radius, borderCurve: "continuous" });
  expect(flat(clipOf(root))).toMatchObject({ borderRadius: radius });
  expect(flat(host(root, "searchPanelFieldRow"))).toMatchObject({ paddingHorizontal: searchPanel.fieldInset, paddingTop: searchPanel.fieldInset });
  expect(flat(host(root, "trayFieldCapsule"))).toMatchObject({ height: searchPanel.fieldHeight, borderRadius: searchPanel.fieldHeight / 2 });
  expect(stage()).toMatchObject({ fieldInset: searchPanel.fieldInset, fieldTop: searchPanel.fieldInset, fieldCenter: searchPanel.fieldInset + searchPanel.fieldHeight / 2, morphCorners: { panel: radius, field: searchPanel.fieldHeight / 2 } });
  unmount(root);
});

onIPhone("larger text grows the field to the native field's capped scale, and the panel's corner and the morph's field centre follow it", () => {
  textSize(1.2);
  act(() => presentSearch("start", ""));
  const root = tray();
  const grown = searchPanel.fieldHeight * 1.2;
  expect(flat(host(root, "trayFieldCapsule")).height).toBeCloseTo(grown);
  expect(flat(host(root, "trayFieldCapsule")).borderRadius).toBeCloseTo(grown / 2);
  expect(stage().fieldCenter as number).toBeCloseTo(searchPanel.fieldInset + grown / 2);
  expect((stage().morphCorners as { panel: number }).panel).toBeCloseTo(grown / 2 + searchPanel.fieldInset);
  expect((stage().morphCorners as { field: number }).field).toBeCloseTo(grown / 2);
  unmount(root);
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  textSize(3);
  act(() => presentSearch("start", ""));
  const huge = tray();
  expect(flat(host(huge, "trayFieldCapsule")).height).toBeCloseTo(searchPanel.fieldHeight * searchPanel.maxTextScale);
  unmount(huge);
});

onIPhone("Clear and Voice are field accessories with 44-point targets, and Incognito is a switch with its checked state", () => {
  jest.spyOn(voice, "canSearchByVoice").mockReturnValue(true);
  act(() => presentSearch("start", ""));
  const root = tray();
  const mic = pressable(root, "Voice Search");
  expect(mic.props.accessibilityRole).toBe("button");
  expect(flat(mic).width).toBeGreaterThanOrEqual(44);
  expect(flat(mic).height).toBeGreaterThanOrEqual(44);
  expect(flat(pressStyled(root, (node) => node.props.accessibilityLabel === "Voice Search"), true).opacity).toBe(press.iconOpacity);
  const eyes = pressable(root, "Incognito");
  expect(eyes.props.accessibilityRole).toBe("switch");
  expect(eyes.props.accessibilityState).toMatchObject({ checked: false });
  expect(flat(eyes).height).toBeGreaterThanOrEqual(44);
  expect(flat(eyes).minWidth).toBeGreaterThanOrEqual(44);
  act(() => pressStyled(root, (node) => node.props.accessibilityLabel === "Incognito").props.onPress());
  expect(useTabs.getState().incognito).toBe(true);
  expect(pressable(root, "Incognito").props.accessibilityState).toMatchObject({ checked: true });
  unmount(root);
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  act(() => presentSearch("page", "otter"));
  act(() => typeSearch("otter"));
  const typed = tray();
  const clear = pressable(typed, "Clear Text");
  expect(flat(clear).width).toBeGreaterThanOrEqual(44);
  expect(flat(clear).height).toBeGreaterThanOrEqual(44);
  expect(clear.findAll((node) => node.type === Symbol && node.props.name === iconRoles.clearText)).toHaveLength(1);
  unmount(typed);
});

onIPhone("the current page's Edit and Copy Link are sibling targets: the copy is not inside the edit, draws the link glyph with its own press, and the arrow is decorative", () => {
  editPage();
  const root = tray();
  act(() => jest.runOnlyPendingTimers());
  const edit = host(root, "trayCurrentPage")!;
  const copy = host(root, "trayCurrentPageCopy")!;
  expect(edit.findAll((node) => node.props.testID === "trayCurrentPageCopy")).toHaveLength(0);
  expect(edit.props.accessibilityHint).toBe("Puts this page’s address in the search field.");
  expect(copy.props.accessibilityLabel).toBe("Copy Link");
  expect(copy.findAll((node) => node.type === Symbol && node.props.name === iconRoles.copyLink)).toHaveLength(1);
  expect(flat(copy).width).toBeGreaterThanOrEqual(44);
  expect(flat(pressStyled(root, (node) => node.props.testID === "trayCurrentPageCopy"), true).opacity).toBe(press.iconOpacity);
  expect(host(root, "trayCurrentPageArrow")!.props.accessibilityElementsHidden).toBe(true);
  const copied = jest.spyOn(tabMenus, "copyLink").mockImplementation(() => undefined);
  act(() => pressStyled(root, (node) => node.props.testID === "trayCurrentPageCopy").props.onPress());
  expect(copied).toHaveBeenCalledTimes(1);
  unmount(root);
});

onIPhone("the current page's title wraps at large text the way the suggestion rows' titles do", () => {
  textSize(1.6);
  editPage();
  const root = tray();
  act(() => jest.runOnlyPendingTimers());
  const title = host(root, "trayCurrentPage")!.findAll((node) => typeof node.type === "string" && node.props.numberOfLines !== undefined)[0]!;
  expect(title.props.numberOfLines).toBe(3);
  unmount(root);
});

onIPhone("as the panel starts to close its content stops taking touches and leaves the screen reader at once", () => {
  act(() => presentSearch("start", ""));
  const root = tray();
  expect(host(root, "trayStagedContent")!.props.pointerEvents).toBe("auto");
  act(() => browse.cancelSearch());
  const leaving = host(root, "trayStagedContent")!;
  expect(leaving.props.pointerEvents).toBe("none");
  expect(leaving.props.accessibilityElementsHidden).toBe(true);
  unmount(root);
});
