import { Platform, StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { startingTheme } from "@ardia/core/src/theme.ts";
import { ExpoChoiceRow, ExpoSettingsAction } from "../components/settings/ExpoSettingsParts";
import { SettingsView } from "../components/settings/SettingsView";
import { ThemePage } from "../components/settings/ThemePage";
import { TRUSTED_SITES_EMPTY } from "../components/settings/ExpoBlockingPages";
import { actionLayout, controlSize, DesignProvider, useTheme, type Theme } from "../components/ui";
import { primaryActionRoles } from "../components/ui/tokens";
import { tint } from "@expo/ui/swift-ui/modifiers";
import * as settingsActions from "../state/settings/actions";
import * as defaultBrowser from "../state/settings/defaultBrowser";
import { closeSettings, openSettings, pushSettings, type SettingsRoute } from "../state/settings/nav";
import { setPreference, usePreferences } from "../state/settings/store";
import * as syncActions from "../state/sync/actions";
import { OFF_STATUS, useSync } from "../state/sync/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;

jest.mock("../components/ui/settingsPieces", () => ({ ...jest.requireActual("../components/ui/settingsPieces"), settingsChrome: () => ({ $type: "ardia.settingsChrome" }) }));

const EMPTY_VIEW = { devices: [], profiles: [], search: null, syncedAt: null, selectedProfileId: null, receivers: [] };

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useSync.setState((state) => ({ ...state, status: OFF_STATUS, view: EMPTY_VIEW as never }));
});

afterEach(() => {
  act(() => closeSettings());
  act(() => jest.runOnlyPendingTimers());
  useSync.setState((state) => ({ ...state, status: OFF_STATUS, view: EMPTY_VIEW as never }));
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
type Modifier = { $type: string; [key: string]: unknown };

const within = (node: ReactTestInstance, has: (props: Record<string, unknown>) => boolean) => node.findAll((inner) => typeof inner.type === "string" && has(inner.props));
const modifiersOf = (node: ReactTestInstance) => (node.props.modifiers as Modifier[] | undefined) ?? [];
const modifier = (node: ReactTestInstance, type: string) => modifiersOf(node).find((item) => item.$type === type);
const destination = (root: Root, value: string) => root.root.findAll((node) => typeof node.type === "string" && node.props.name === "destination" && (node.props.extraProps as { value?: string } | undefined)?.value === value)[0]!;
const press = async (node: ReactTestInstance) => act(async () => void (node.props.onButtonPress ?? node.props.onPress)({ nativeEvent: {} }));

const open = async (route: SettingsRoute) => {
  openSettings(route);
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  return root;
};

onIos("Appearance and Search Engine draw their choices with the one shared choice row, each checked row carrying the selected trait", async () => {
  settingsActions.useEngines.setState({ engines: [{ id: "google", name: "Google" }, { id: "bing", name: "Bing" }] } as never);
  setPreference("searchEngineId", "google");
  const engines = await open({ page: "searchEngine" });
  const engineRows = engines.root.findAll((node) => node.type === ExpoChoiceRow);
  expect(engineRows.length).toBeGreaterThan(1);
  expect(engineRows.filter((row) => row.props.checked).map((row) => row.props.title)).toEqual(["Google"]);
  unmount(engines);
  const appearance = await open({ page: "appearance" });
  const choiceRows = appearance.root.findAll((node) => node.type === ExpoChoiceRow);
  expect(choiceRows.length).toBeGreaterThan(3);
  for (const row of choiceRows) {
    const button = within(row, (props) => Array.isArray(props.modifiers))[0]!;
    const traits = (modifier(button, "accessibilityAddTraits")?.traits as string[] | undefined) ?? [];
    expect(traits.includes("isSelected")).toBe(row.props.checked);
  }
  expect(within(appearance.root, (props) => props.text === "Color")).toHaveLength(1);
  expect(within(destination(appearance, "appearance"), (props) => StyleSheet.flatten(props.style as never)?.experimental_backgroundImage !== undefined)).toHaveLength(0);
  unmount(appearance);
});

onIos("Settings' primary actions share one role: Default Browser and Sync's connect are full-width prominent buttons with actionLayout's corner, the setup steps the compact variant", async () => {
  jest.spyOn(defaultBrowser, "refreshDefaultBrowser").mockResolvedValue(null);
  defaultBrowser.useDefaultBrowser.setState({ status: { isDefault: false, canAsk: false, isOffered: true } as never });
  const browser = await open({ page: "defaultBrowser" });
  const sync = await open({ page: "sync" });
  const actions = [...browser.root.findAll((node) => node.type === ExpoSettingsAction), ...sync.root.findAll((node) => node.type === ExpoSettingsAction)];
  expect(actions.map((action) => action.props.size)).toEqual(["full", "full"]);
  for (const action of actions) {
    const button = within(action, (props) => Array.isArray(props.modifiers))[0]!;
    expect(modifier(button, "buttonBorderShape")).toMatchObject({ shape: "roundedRectangle", cornerRadius: actionLayout.radius.regular });
    expect(modifier(button, "controlSize")).toMatchObject({ size: "large" });
    expect(modifier(button, "buttonStyle")).toMatchObject({ style: "borderedProminent" });
    expect(modifier(button, "font")).toMatchObject({ weight: "semibold" });
  }
  unmount(browser);
  unmount(sync);
  const connect = await open({ page: "syncConnect" });
  const steps = connect.root.findAll((node) => node.type === ExpoSettingsAction);
  expect(steps.length).toBeGreaterThan(0);
  for (const step of steps) {
    expect(step.props.size).toBe("compact");
    const button = within(step, (props) => Array.isArray(props.modifiers))[0]!;
    expect(modifier(button, "buttonBorderShape")).toMatchObject({ cornerRadius: actionLayout.radius.compact });
    expect(modifier(button, "font")).toMatchObject({ weight: "semibold" });
  }
  unmount(connect);
});

onIos("Sync Now keeps its spoken name while it runs, shows progress beside it and is locked until it ends", async () => {
  let finish: () => void = () => undefined;
  jest.spyOn(syncActions, "syncNow").mockReturnValue(new Promise<void>((resolve) => (finish = resolve)) as never);
  useSync.setState((state) => ({ ...state, status: { ...OFF_STATUS, isEnabled: true, phase: "updated", deviceName: "Phone", folderName: "Ardia Sync" } }));
  const root = await open({ page: "sync" });
  const syncButton = () => within(destination(root, "sync"), (props) => Array.isArray(props.modifiers)).find((node) => modifier(node, "disabled") !== undefined && within(node, (props) => props.text === "Sync Now").length > 0)!;
  expect(modifier(syncButton(), "disabled")).toMatchObject({ disabled: false });
  await press(syncButton());
  expect(within(destination(root, "sync"), (props) => props.text === "Syncing…")).toHaveLength(0);
  expect(modifier(syncButton(), "disabled")).toMatchObject({ disabled: true });
  expect(modifier(syncButton(), "accessibilityValue")).toBeDefined();
  await act(async () => finish());
  expect(modifier(syncButton(), "disabled")).toMatchObject({ disabled: false });
  unmount(root);
});

onIos("while Clear Data runs, the range and the switches that make up the submission are locked", async () => {
  let finish: () => void = () => undefined;
  jest.spyOn(settingsActions, "clearBrowsingData").mockReturnValue(new Promise<void>((resolve) => (finish = resolve)) as never);
  jest.spyOn(settingsActions, "websiteDataClearsByTime").mockReturnValue(true);
  const root = await open({ page: "clearData" });
  const page = () => destination(root, "clearData");
  const locked = () => within(page(), (props) => props.isOn !== undefined || props.label === "Time Range").map((node) => modifier(node, "disabled")?.disabled);
  expect(locked().every((value) => value === false)).toBe(true);
  await press(within(page(), (props) => props.label === "Clear Data")[0]!);
  expect(locked().length).toBeGreaterThan(0);
  expect(locked().every((value) => value === true)).toBe(true);
  await act(async () => finish());
  unmount(root);
});

onIos("Add a List and the hosted theme editor get the grouped Settings chrome like every other Settings route", async () => {
  useSync.setState((state) => ({ ...state }));
  const lists = await open({ page: "filterLists" });
  await press(within(lists.root, (props) => props.label === "Add a List…")[0]!);
  const addForm = within(lists.root, (props) => Array.isArray(props.modifiers) && (props.modifiers as Modifier[]).some((item) => item.$type === "navigationTitle" && item.title === "Add a List"))[0]!;
  expect(modifier(addForm, "ardia.settingsChrome")).toBeDefined();
  unmount(lists);
  act(() => usePreferences.setState({ colorChoice: "custom", customTheme: startingTheme("#4691C3") }));
  openSettings({ page: "appearance" });
  act(() => pushSettings({ page: "theme" }));
  const theme = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const host = within(destination(theme, "theme"), (props) => Array.isArray(props.modifiers) && (props.modifiers as Modifier[]).some((item) => item.$type === "navigationTitle"))[0]!;
  expect(modifier(host, "ardia.settingsChrome")).toBeDefined();
  unmount(theme);
});

test("Trusted Sites' empty state names what it keeps with the page menu's own label", () => {
  expect(TRUSTED_SITES_EMPTY.message).toContain("Block Ads and Trackers");
  expect(TRUSTED_SITES_EMPTY.message).not.toMatch(/allow/i);
});

test("the theme editor's Add and Remove Color keep their 32-point plates inside 44-point targets", () => {
  act(() => usePreferences.setState({ colorChoice: "custom", customTheme: startingTheme("#4691C3") }));
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <ThemePage />
    </DesignProvider>,
  );
  const steppers = root.root.findAll((node) => node.props.testID === "themeStepper" && typeof node.type === "string");
  expect(steppers.map((node) => node.props.accessibilityLabel)).toEqual(["Remove Color", "Add Color"]);
  for (const stepper of steppers) expect(StyleSheet.flatten(stepper.props.style)).toMatchObject({ width: controlSize.hitTarget, height: controlSize.hitTarget });
  unmount(root);
});

onIos("the native primary actions take the named roles the drawn ones use: the accent fill, the role's corner and size, and compact labels wrap instead of running out of room", async () => {
  let theme: Theme | null = null;
  function ThemeProbe() {
    theme = useTheme();
    return null;
  }
  const probe = renderSurface(<ThemeProbe />);
  const connect = await open({ page: "syncConnect" });
  const steps = connect.root.findAll((node) => node.type === ExpoSettingsAction);
  expect(steps.length).toBeGreaterThan(1);
  for (const step of steps) {
    const button = within(step, (props) => Array.isArray(props.modifiers))[0]!;
    expect(modifier(button, "lineLimit")).toBeUndefined();
    expect(modifier(button, "fixedSize")).toMatchObject({ horizontal: false, vertical: true });
    expect(modifier(button, "buttonBorderShape")).toMatchObject({ cornerRadius: primaryActionRoles.compact.radius });
    expect(modifier(button, "controlSize")).toMatchObject({ size: primaryActionRoles.compact.nativeControlSize });
  }
  const primary = steps.find((step) => (step.props.emphasis ?? "primary") === "primary")!;
  const primaryButton = within(primary, (props) => Array.isArray(props.modifiers))[0]!;
  expect(modifier(primaryButton, "tint")).toEqual(tint(theme![primaryActionRoles.compact.fill]));
  expect(primaryActionRoles.full.fill).toBe(primaryActionRoles.hero.fill);
  expect(primaryActionRoles.full.radius).toBe(actionLayout.radius.regular);
  expect(primaryActionRoles.hero.height).toBe(actionLayout.height.hero);
  unmount(connect);
  unmount(probe);
});
