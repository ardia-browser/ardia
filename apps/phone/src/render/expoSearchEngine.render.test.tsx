import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { SettingsView } from "../components/settings/SettingsView";
import * as settingsActions from "../state/settings/actions";
import { openSettings } from "../state/settings/nav";
import { setPreference } from "../state/settings/store";
import { OFF_STATUS, useSync } from "../state/sync/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;

const ENGINES = [
  { id: "google", name: "Google" },
  { id: "duckduckgo", name: "DuckDuckGo" },
  { id: "bing", name: "Bing" },
];

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  settingsActions.useEngines.setState({ engines: ENGINES });
  setPreference("searchEngineId", "google");
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  useSync.setState((state) => ({ ...state, status: OFF_STATUS, view: { devices: [], profiles: [], search: null, syncedAt: null, selectedProfileId: null, receivers: [] } as never }));
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const page = (root: Root) => root.root.findAll((node) => typeof node.type === "string" && node.props.name === "destination" && (node.props.extraProps as { value?: string } | undefined)?.value === "searchEngine")[0]!;
const within = (node: ReactTestInstance, has: (props: Record<string, unknown>) => boolean) => node.findAll((inner) => typeof inner.type === "string" && has(inner.props));
const traitsOf = (node: ReactTestInstance) => ((node.props.modifiers as { $type: string; traits?: string[] }[]) ?? []).find((modifier) => modifier.$type === "accessibilityAddTraits")?.traits ?? [];
const rows = (root: Root) => within(page(root), (props) => typeof props.onButtonPress === "function" || typeof props.onPress === "function").filter((node) => traitsOf(node).includes("isButton"));
const nameOf = (node: ReactTestInstance) => within(node, (props) => typeof props.text === "string")[0]!.props.text as string;

onIos("on iPhone Search Engine is main's list on Expo UI: each engine a row, the chosen one checked and selected, and a press chooses another", async () => {
  const choose = jest.spyOn(settingsActions, "setSearchEngine");
  openSettings({ page: "searchEngine" });
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const engines = settingsActions.useEngines.getState().engines;
  expect(rows(root).map(nameOf)).toEqual(engines.map((engine) => engine.name));
  expect(rows(root).filter((row) => traitsOf(row).includes("isSelected")).map(nameOf)).toEqual(["Google"]);
  expect(within(page(root), (props) => props.systemName === "checkmark")).toHaveLength(1);
  const duck = rows(root).find((row) => nameOf(row) === "DuckDuckGo")!;
  await act(async () => void (duck.props.onButtonPress ?? duck.props.onPress)({ nativeEvent: {} }));
  expect(choose).toHaveBeenCalledWith("duckduckgo");
  unmount(root);
});

onIos("with sync on and an engine from the Mac, it shows From Your Mac with the engine's name and main's footer", async () => {
  useSync.setState((state) => ({ ...state, status: { ...OFF_STATUS, isEnabled: true, phase: "updated" }, view: { devices: [], profiles: [], search: { engineId: "bing", customEngines: [] }, syncedAt: 1, selectedProfileId: null, receivers: [] } as never }));
  openSettings({ page: "searchEngine" });
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  expect(within(page(root), (props) => props.label === "From Your Mac")).toHaveLength(1);
  expect(within(page(root), (props) => props.text === "Set on your Mac.")).toHaveLength(1);
  unmount(root);
});
