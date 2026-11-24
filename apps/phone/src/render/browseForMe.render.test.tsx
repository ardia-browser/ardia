import { Platform } from "react-native";
import { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

const core = require("expo-modules-core") as { requireOptionalNativeModule: (name: string) => unknown };
const realOptional = core.requireOptionalNativeModule;

type Listener = (event: Record<string, unknown>) => void;

let available = true;
let listeners: Listener[] = [];
const native = {
  open: jest.fn(async (_query: string) => undefined),
  isConnected: jest.fn(async () => false),
  addListener: jest.fn((_name: string, listener: Listener) => {
    listeners.push(listener);
    return { remove: () => undefined };
  }),
};
jest.spyOn(core, "requireOptionalNativeModule").mockImplementation((name: string) => (name === "ArdiaPhoneBrowseForMe" ? (available ? native : null) : realOptional(name)));

const { SearchTray } = require("../components/search/SearchTray") as typeof import("../components/search/SearchTray");
const { VoiceSearchView } = require("../components/search/VoiceSearchView") as typeof import("../components/search/VoiceSearchView");
const { SettingsView } = require("../components/settings/SettingsView") as typeof import("../components/settings/SettingsView");
const { listenForBrowseForMe } = require("../state/browseForMe/events") as typeof import("../state/browseForMe/events");
const { browseForMeOffered } = require("../state/browseForMe/offer") as typeof import("../state/browseForMe/offer");
const { closeSettings, offerBrowseForMePage, openSettings, settingsNav } = require("../state/settings/nav") as typeof import("../state/settings/nav");
const { dismissSearch, presentSearch, setSearchText, useSearch } = require("../state/search/store") as typeof import("../state/search/store");
const { currentTabs } = require("../state/tabs/store") as typeof import("../state/tabs/store");
const { useVoice } = require("../state/voice/store") as typeof import("../state/voice/store");
const { DICTATION_IDLE } = require("../state/voice/dictation") as typeof import("../state/voice/dictation");
const { pressButton, renderSurface, textOf, unmount, withTabs } = require("../../test/render/harness") as typeof import("../../test/render/harness");

const onIos = Platform.OS === "ios" ? test : test.skip;

const send = (event: Record<string, unknown>) => act(() => listeners.forEach((listener) => listener(event)));

const shows = (root: ReactTestRenderer, words: string) => root.root.findAll((node) => typeof node.type === "string" && node.props.text === words).length > 0;

const rowKinds = () => useSearch.getState().rows.map((row) => row.kind);

beforeAll(() => {
  offerBrowseForMePage(browseForMeOffered);
  listenForBrowseForMe();
});

beforeEach(() => {
  jest.useFakeTimers();
  available = true;
  native.open.mockClear();
  withTabs(2);
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => closeSettings());
  act(() => useVoice.setState({ presented: false, dictation: DICTATION_IDLE }));
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

test("a plain search shows Browse for Me under the typed query, and choosing it opens the native page on that query and closes the tray", async () => {
  act(() => presentSearch("home", ""));
  const root = renderSurface(<SearchTray />);
  act(() => setSearchText("otter facts"));
  const kinds = rowKinds();
  expect(kinds[kinds.indexOf("browseForMe") - 1]).toBe("query");
  expect(textOf(root)).toContain("Browse for Me");
  await pressButton(root, "Browse for Me");
  expect(native.open).toHaveBeenCalledWith("otter facts");
  expect(useSearch.getState().open).toBe(false);
  unmount(root);
});

test("an address offers no Browse for Me row", () => {
  act(() => presentSearch("home", ""));
  act(() => setSearchText("example.com"));
  expect(rowKinds()).not.toContain("browseForMe");
});

test("without the native page, as on Android, no tray row, no voice button and no Settings page", () => {
  available = false;
  act(() => presentSearch("home", ""));
  act(() => setSearchText("otter facts"));
  expect(rowKinds()).not.toContain("browseForMe");
  act(() => useVoice.setState({ presented: true, dictation: { ...DICTATION_IDLE, phase: "finished", transcript: "otter facts" } }));
  const voice = renderSurface(<VoiceSearchView />);
  expect(textOf(voice)).toContain("Search");
  expect(textOf(voice)).not.toContain("Browse for Me");
  unmount(voice);
  act(() => openSettings({ page: "browseForMe" }));
  expect(settingsNav().open).toBe(false);
});

test("voice search offers Browse for Me beside Search once words are heard, and it opens the native page on them", async () => {
  act(() => useVoice.setState({ presented: true, dictation: { ...DICTATION_IDLE, phase: "finished", transcript: "how tall is everest" } }));
  const voice = renderSurface(<VoiceSearchView />);
  await pressButton(voice, "Browse for Me");
  expect(native.open).toHaveBeenCalledWith("how tall is everest");
  expect(useVoice.getState().presented).toBe(false);
  unmount(voice);
});

const textsIn = (node: ReactTestInstance) => node.findAll((child) => typeof child.type === "string" && typeof child.props.text === "string").map((child) => child.props.text as string);
const paneTitles = (root: ReactTestRenderer) => root.root.findAll((node) => typeof node.type === "string" && typeof node.props.title === "string" && typeof node.props.systemImage === "string").map((node) => node.props.title as string);

onIos("Settings lists Experimental as a pane holding Browse for Me, saying On iPhone until ChatGPT is connected, and drops the pane without the native page", () => {
  act(() => openSettings());
  const root: ReactTestRenderer = renderSurface(<SettingsView />);
  expect(paneTitles(root)).toContain("Experimental");
  unmount(root);
  act(() => openSettings({ page: "experimental" }));
  const pane: ReactTestRenderer = renderSurface(<SettingsView />);
  expect(textsIn(pane.root)).toContain("Browse for Me");
  const links = pane.root.findAll((node) => typeof node.type === "string" && typeof node.props.value === "string" && !("path" in node.props)).map((node) => node.props.value);
  expect(links).toContain("browseForMe");
  expect(shows(pane, "On iPhone")).toBe(true);
  send({ name: "account", connected: true });
  expect(shows(pane, "ChatGPT")).toBe(true);
  expect(shows(pane, "On iPhone")).toBe(false);
  send({ name: "account", connected: false });
  unmount(pane);
  available = false;
  act(() => openSettings());
  const without: ReactTestRenderer = renderSurface(<SettingsView />);
  expect(paneTitles(without)).not.toContain("Experimental");
  unmount(without);
});

test("a source from the answer page opens as a normal tab, Search the Web searches the query, and Check Usage leaves Settings for its page", () => {
  const before = currentTabs().open.length;
  send({ name: "openSource", url: "https://en.wikipedia.org/wiki/Mount_Everest" });
  expect(currentTabs().open.length).toBe(before + 1);
  expect(currentTabs().open.some((tab) => tab.url === "https://en.wikipedia.org/wiki/Mount_Everest" && !tab.isPrivate)).toBe(true);
  send({ name: "searchWeb", query: "mount everest height" });
  expect(currentTabs().open.length).toBe(before + 2);
  act(() => openSettings({ page: "browseForMe" }));
  expect(settingsNav().open).toBe(true);
  send({ name: "openLink", url: "https://chatgpt.com/settings/usage" });
  expect(settingsNav().open).toBe(false);
  expect(currentTabs().open.some((tab) => tab.url === "https://chatgpt.com/settings/usage")).toBe(true);
});
