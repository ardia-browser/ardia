import { Platform } from "react-native";
import { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

const core = require("expo-modules-core") as { requireOptionalNativeModule: (name: string) => unknown };
const realOptional = core.requireOptionalNativeModule;

let connected = false;
let signsIn = true;
const account = () => ({ connected, label: connected ? "reader@example.com" : null, signingIn: false, problem: null, model: null, effort: null, models: [] });
const browseNative = {
  open: jest.fn(async (_query: string) => undefined),
  isConnected: jest.fn(async () => connected),
  account: jest.fn(async () => account()),
  connect: jest.fn(async () => {
    if (signsIn) connected = true;
    return signsIn;
  }),
  clearProblem: jest.fn(async () => undefined),
  addListener: jest.fn(() => ({ remove: () => undefined })),
};
jest.spyOn(core, "requireOptionalNativeModule").mockImplementation((name: string) => (name === "ArdiaPhoneBrowseForMe" ? browseNative : realOptional(name)));

const { pages } = require("../platform/pages") as typeof import("../platform/pages");
const { SettingsView } = require("../components/settings/SettingsView") as typeof import("../components/settings/SettingsView");
const { closeSettings, offerPageSummaryPage, openSettings, settingsNav } = require("../state/settings/nav") as typeof import("../state/settings/nav");
const { pageSummaryChoiceOffered, usePageSummary } = require("../state/pageSummary/store") as typeof import("../state/pageSummary/store");
const { refreshPageSummariesEnabled, setPageSummariesEnabled, usePageSummariesSwitch } = require("../state/pageSummary/enabled") as typeof import("../state/pageSummary/enabled");
const { useBrowseForMe } = require("../state/browseForMe/store") as typeof import("../state/browseForMe/store");
const { renderSurface, textOf, unmount, withTabs } = require("../../test/render/harness") as typeof import("../../test/render/harness");

const onAndroid = Platform.OS === "android" ? test : test.skip;
const onIos = Platform.OS === "ios" ? test : test.skip;

const titledHosts = (node: ReactTestInstance) => node.findAll((inner) => typeof inner.type === "string" && typeof inner.props.text === "string").map((inner) => inner.props.text as string);
const expoSummaryToggle = (root: ReactTestRenderer) => root.root.findAll((node) => typeof node.type === "string" && typeof node.props.isOn === "boolean").find((node) => titledHosts(node).includes("Pinch to Summarize"));

let stored: "on_device" | "chatgpt" = "on_device";
let offered = true;
let enabledStored = false;
let switchable = true;
let switched: jest.SpyInstance;
let chosen: jest.SpyInstance;
let summarized: jest.SpyInstance;

const choice = (root: ReactTestRenderer, title: string): ReactTestInstance => root.root.findAll((node) => node.props.testID === `pageSummaryChoice:${title}` && typeof node.props.onPress === "function")[0]!;

const summariesSwitch = (root: ReactTestRenderer): ReactTestInstance => root.root.findAll((node) => node.props.accessibilityRole === "switch" && node.props.accessibilityLabel === "Pinch to Summarize" && typeof node.props.onPress === "function")[0]!;

const choices = (root: ReactTestRenderer) => root.root.findAll((node) => typeof node.props.testID === "string" && node.props.testID.startsWith("pageSummaryChoice:") && typeof node.props.onPress === "function");

const press = async (node: ReactTestInstance) => {
  await act(async () => {
    node.props.onPress();
  });
};

beforeAll(() => offerPageSummaryPage(pageSummaryChoiceOffered));

beforeEach(() => {
  jest.useFakeTimers();
  connected = false;
  signsIn = true;
  stored = "on_device";
  offered = true;
  enabledStored = false;
  switchable = true;
  browseNative.connect.mockClear();
  usePageSummary.setState({ provider: "on_device" });
  usePageSummariesSwitch.setState({ enabled: false });
  jest.spyOn(pages, "switchesSummaries").mockImplementation(() => offered && switchable);
  jest.spyOn(pages, "summariesEnabled").mockImplementation(async () => enabledStored);
  switched = jest.spyOn(pages, "setSummariesEnabled").mockImplementation(async (enabled) => {
    enabledStored = enabled;
    return enabled;
  });
  useBrowseForMe.setState({ connected: false, account: null });
  jest.spyOn(pages, "choosesSummaryProvider").mockImplementation(() => offered);
  jest.spyOn(pages, "summaryProvider").mockImplementation(async () => stored);
  chosen = jest.spyOn(pages, "setSummaryProvider").mockImplementation(async (provider) => {
    stored = provider;
    return provider;
  });
  summarized = jest.spyOn(pages, "summarize").mockResolvedValue(true);
  withTabs(1);
});

afterEach(() => {
  act(() => closeSettings());
  act(() => jest.runOnlyPendingTimers());
  jest.restoreAllMocks();
  jest.spyOn(core, "requireOptionalNativeModule").mockImplementation((name: string) => (name === "ArdiaPhoneBrowseForMe" ? browseNative : realOptional(name)));
  jest.useRealTimers();
});

onAndroid("without the native choice, as on iPhone, there is no Pinch to Summarize row or page", () => {
  offered = false;
  act(() => openSettings({ page: "pageSummary" }));
  expect(settingsNav().open).toBe(false);
  act(() => openSettings());
  const root = renderSurface(<SettingsView />);
  expect(textOf(root)).not.toContain("Pinch to Summarize");
  unmount(root);
});

onAndroid("Settings lists Pinch to Summarize under Experimental as Off until it's turned on, and its page offers only the switch while off", async () => {
  act(() => openSettings());
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  expect(textOf(root)).toContain("Pinch to Summarize");
  expect(textOf(root)).toContain("Pinch to Summarize\nOff");
  unmount(root);
  act(() => openSettings({ page: "pageSummary" }));
  const page = renderSurface(<SettingsView />);
  await act(async () => undefined);
  expect(summariesSwitch(page).props.accessibilityState).toMatchObject({ checked: false });
  expect(choices(page)).toHaveLength(0);
  expect(textOf(page)).toContain("Off until you turn it on");
  expect(switched).not.toHaveBeenCalled();
  expect(summarized).not.toHaveBeenCalled();
  unmount(page);
});

onAndroid("turning it on saves it, shows On This Phone chosen, and says what choosing ChatGPT sends, Incognito included", async () => {
  act(() => openSettings({ page: "pageSummary" }));
  const page = renderSurface(<SettingsView />);
  await act(async () => undefined);
  await press(summariesSwitch(page));
  expect(switched).toHaveBeenLastCalledWith(true);
  expect(enabledStored).toBe(true);
  expect(summariesSwitch(page).props.accessibilityState).toMatchObject({ checked: true });
  expect(choice(page, "On This Phone").props.accessibilityState).toMatchObject({ selected: true });
  expect(choice(page, "ChatGPT").props.accessibilityState).toMatchObject({ selected: false });
  expect(textOf(page)).toMatch(/sends the text Ardia extracts from each page you summarize, Incognito pages included, straight from this phone to OpenAI/);
  expect(textOf(page)).toContain("Gemini Nano, on phones that have it");
  expect(textOf(page)).not.toContain("key lines");
  expect(summarized).not.toHaveBeenCalled();
  unmount(page);
  act(() => openSettings());
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  expect(textOf(root)).toContain("On This Phone");
  unmount(root);
});

onAndroid("the provider is remembered on its own: turning summaries off and on again keeps ChatGPT, and off never changes it", async () => {
  enabledStored = true;
  stored = "chatgpt";
  connected = true;
  act(() => openSettings({ page: "pageSummary" }));
  const page = renderSurface(<SettingsView />);
  await act(async () => undefined);
  expect(choice(page, "ChatGPT").props.accessibilityState).toMatchObject({ selected: true });
  await press(summariesSwitch(page));
  expect(enabledStored).toBe(false);
  expect(choices(page)).toHaveLength(0);
  await press(summariesSwitch(page));
  expect(enabledStored).toBe(true);
  expect(choice(page, "ChatGPT").props.accessibilityState).toMatchObject({ selected: true });
  expect(chosen).not.toHaveBeenCalled();
  expect(stored).toBe("chatgpt");
  unmount(page);
});

onAndroid("a failed read counts as off, and a read that started before a change never overwrites it", async () => {
  jest.spyOn(pages, "summariesEnabled").mockRejectedValueOnce(new Error("gone"));
  usePageSummariesSwitch.setState({ enabled: true });
  await act(async () => refreshPageSummariesEnabled());
  expect(usePageSummariesSwitch.getState().enabled).toBe(false);
  let answer = (_enabled: boolean) => {};
  jest.spyOn(pages, "summariesEnabled").mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
  const reading = refreshPageSummariesEnabled();
  await act(async () => void (await setPageSummariesEnabled(true)));
  await act(async () => {
    answer(false);
    await reading;
  });
  expect(usePageSummariesSwitch.getState().enabled).toBe(true);
  expect(enabledStored).toBe(true);
});

onAndroid("a failed save shows what the phone kept rather than the tap", async () => {
  switched.mockRejectedValueOnce(new Error("busy"));
  await act(async () => void (await setPageSummariesEnabled(true)));
  expect(usePageSummariesSwitch.getState().enabled).toBe(false);
});

onAndroid("choosing ChatGPT without an account signs in first, saves the choice only once connected, and never summarizes a page by itself", async () => {
  enabledStored = true;
  act(() => openSettings({ page: "pageSummary" }));
  const page = renderSurface(<SettingsView />);
  await act(async () => undefined);
  signsIn = false;
  await press(choice(page, "ChatGPT"));
  expect(browseNative.connect).toHaveBeenCalledTimes(1);
  expect(chosen).not.toHaveBeenCalled();
  expect(usePageSummary.getState().provider).toBe("on_device");
  signsIn = true;
  await press(choice(page, "ChatGPT"));
  expect(browseNative.connect).toHaveBeenCalledTimes(2);
  expect(chosen).toHaveBeenCalledWith("chatgpt");
  expect(usePageSummary.getState().provider).toBe("chatgpt");
  expect(choice(page, "ChatGPT").props.accessibilityState).toMatchObject({ selected: true });
  expect(summarized).not.toHaveBeenCalled();
  unmount(page);
});

onAndroid("choosing On This Phone while ChatGPT signs in keeps later summaries on this phone", async () => {
  enabledStored = true;
  let finishSignIn = () => {};
  browseNative.connect.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { finishSignIn = resolve; });
    connected = true;
    return true;
  });
  act(() => openSettings({ page: "pageSummary" }));
  const page = renderSurface(<SettingsView />);
  await act(async () => undefined);
  await press(choice(page, "ChatGPT"));
  await press(choice(page, "On This Phone"));
  await act(async () => finishSignIn());
  expect(chosen).toHaveBeenCalledWith("on_device");
  expect(chosen).not.toHaveBeenCalledWith("chatgpt");
  expect(usePageSummary.getState().provider).toBe("on_device");
  unmount(page);
});

onAndroid("with ChatGPT already connected the choice is saved without another sign-in, and On This Phone takes it back", async () => {
  enabledStored = true;
  connected = true;
  act(() => openSettings({ page: "pageSummary" }));
  const page = renderSurface(<SettingsView />);
  await act(async () => undefined);
  await press(choice(page, "ChatGPT"));
  expect(browseNative.connect).not.toHaveBeenCalled();
  expect(chosen).toHaveBeenLastCalledWith("chatgpt");
  await press(choice(page, "On This Phone"));
  expect(chosen).toHaveBeenLastCalledWith("on_device");
  expect(usePageSummary.getState().provider).toBe("on_device");
  unmount(page);
});

onAndroid("a saved ChatGPT choice survives a disconnected account and the page offers to connect again", async () => {
  enabledStored = true;
  stored = "chatgpt";
  act(() => openSettings({ page: "pageSummary" }));
  const page = renderSurface(<SettingsView />);
  await act(async () => undefined);
  expect(usePageSummary.getState().provider).toBe("chatgpt");
  expect(choice(page, "ChatGPT").props.accessibilityState).toMatchObject({ selected: true });
  expect(textOf(page)).toContain("ChatGPT isn’t connected, so summaries stay on this phone");
  expect(chosen).not.toHaveBeenCalled();
  unmount(page);
});

onIos("iPhone lists Pinch to Summarize as a switch under Experimental, off until turned on, and saves each change without summarizing anything", async () => {
  jest.spyOn(pages, "choosesSummaryProvider").mockReturnValue(false);
  act(() => openSettings({ page: "experimental" }));
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  expect(expoSummaryToggle(root)!.props.isOn).toBe(false);
  await act(async () => expoSummaryToggle(root)!.props.onIsOnChange({ nativeEvent: { isOn: true } }));
  expect(switched).toHaveBeenLastCalledWith(true);
  expect(expoSummaryToggle(root)!.props.isOn).toBe(true);
  await act(async () => expoSummaryToggle(root)!.props.onIsOnChange({ nativeEvent: { isOn: false } }));
  expect(switched).toHaveBeenLastCalledWith(false);
  expect(expoSummaryToggle(root)!.props.isOn).toBe(false);
  expect(summarized).not.toHaveBeenCalled();
  unmount(root);
});

onIos("an iPhone without the native switch shows no Pinch to Summarize row", async () => {
  switchable = false;
  act(() => openSettings({ page: "experimental" }));
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  expect(expoSummaryToggle(root)).toBeUndefined();
  unmount(root);
});
