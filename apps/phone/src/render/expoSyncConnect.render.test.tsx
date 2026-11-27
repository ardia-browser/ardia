import { Modal, Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { SettingsView } from "../components/settings/SettingsView";
import { closeSettings, openSettings, openSettingsPage, popSettings, pushSettings, settingsNav } from "../state/settings/nav";
import { presentationDetents } from "@expo/ui/swift-ui/modifiers";
import { CONNECT_WORDS, connectIsStackRoot, scannerPresentation } from "../components/settings/ExpoSyncConnectPage";
import { connectDetents } from "../components/settings/ExpoSettingsStack";
import { MAC_HINT } from "../state/sync/syncRules";
import { rolesFor } from "../components/ui";
import * as syncActions from "../state/sync/actions";
import { setConnectPhrase } from "../state/sync/connectDraft";
import * as scan from "../state/sync/scan";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";
import { afterScanner } from "../components/settings/ExpoSyncConnectPage";
import { ExpoSettingsAction, titleWhileBusy } from "../components/settings/ExpoSettingsParts";
import { SyncScan } from "../components/sync/SyncScan";
import { createConnectSession } from "../state/sync/connectSession";

jest.mock("@ardia/phone-native/src/settingsUI", () => ({
  ...jest.requireActual<object>("@ardia/phone-native/src/settingsUI"),
  accessibilityFocusRequest: (request: number) => ({ $type: "ardia.accessibilityFocusRequest", request }),
}));

const onIos = Platform.OS === "ios" ? test : test.skip;

const WORDS = Array.from({ length: 24 }, (_, index) => `word${index}`).join(" ");

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  setConnectPhrase("");
  jest.spyOn(scan, "canScanCodes").mockReturnValue(true);
  jest.spyOn(syncActions, "canPickSyncFolderFirst").mockReturnValue(false);
  jest.spyOn(syncActions, "checkPhrase").mockImplementation((phrase: string) => {
    const count = phrase.trim() ? phrase.trim().split(/\s+/).length : 0;
    return { wordCount: count, counterText: `${count}/24 words`, isTooLong: count > 24, problem: null, isValid: count === 24 };
  });
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
const byLabel = (node: ReactTestInstance, label: string) => within(node, (props) => props.label === label)[0]!;
const disabledOf = (node: ReactTestInstance) => ((node.props.modifiers as { $type: string; disabled?: boolean }[] | undefined) ?? []).find((modifier) => modifier.$type === "disabled")?.disabled;
const press = async (node: ReactTestInstance) => act(async () => void (node.props.onButtonPress ?? node.props.onPress)({ nativeEvent: {} }));
const actions = (node: ReactTestInstance) => node.findAll((inner) => inner.type === ExpoSettingsAction);
const buttonOf = (action: ReactTestInstance) => within(action, (props) => Array.isArray(props.modifiers))[0]!;
const onlyAction = (node: ReactTestInstance) => {
  const found = actions(node);
  expect(found).toHaveLength(1);
  return found[0]!;
};
const actionTitled = (node: ReactTestInstance, title: string) => {
  const action = onlyAction(node);
  expect(texts(action)).toEqual([title]);
  return buttonOf(action);
};

onIos("on iPhone Connect to Your Mac is one task at a time on Expo UI: first scanning the Mac's code with one full Scan Code action, then Enter Recovery Phrase pushes main's phrase page, whose Use Phrase brings 24 good words back as the folder task", async () => {
  openSettings({ page: "syncConnect" });
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const connect = () => destination(root, "syncConnect");
  expect(texts(connect())).toEqual([CONNECT_WORDS.scanTitle, MAC_HINT, "Scan Code"]);
  expect(onlyAction(connect()).props.size).toBe("full");
  actionTitled(connect(), "Scan Code");
  await press(byLabel(connect(), "Enter Recovery Phrase"));
  expect(settingsNav().stack.at(-1)).toEqual({ page: "syncWords" });
  const words = () => destination(root, "syncWords");
  expect(disabledOf(byLabel(words(), "Use Phrase"))).toBe(true);
  const field = within(words(), (props) => props.placeholder === "Enter your 24-word recovery phrase")[0]!;
  await act(async () => field.props.onTextChange({ nativeEvent: { value: WORDS } }));
  expect(disabledOf(byLabel(words(), "Use Phrase"))).toBe(false);
  expect(texts(words())).toContain("24/24 words");
  await press(byLabel(words(), "Use Phrase"));
  expect(settingsNav().stack.at(-1)).toEqual({ page: "syncConnect" });
  expect(texts(connect())).toEqual([CONNECT_WORDS.folderTitle, CONNECT_WORDS.folderHint, "Choose Folder…"]);
  expect(within(connect(), (props) => props.title === CONNECT_WORDS.phraseAdded)).toHaveLength(1);
  expect(byLabel(connect(), CONNECT_WORDS.change)).toBeTruthy();
  expect(byLabel(connect(), "Enter Recovery Phrase")).toBeUndefined();
  actionTitled(connect(), "Choose Folder…");
  unmount(root);
});

onIos("without a camera the connect page asks for the code from the Mac and its one action is Enter Recovery Phrase, with no second button under it", async () => {
  jest.spyOn(scan, "canScanCodes").mockReturnValue(false);
  openSettings({ page: "syncConnect" });
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const connect = () => destination(root, "syncConnect");
  expect(texts(connect())).toEqual([CONNECT_WORDS.phraseTitle, MAC_HINT, "Enter Recovery Phrase"]);
  expect(within(connect(), (props) => props.label === "Enter Recovery Phrase")).toHaveLength(0);
  await press(actionTitled(connect(), "Enter Recovery Phrase"));
  expect(settingsNav().stack.at(-1)).toEqual({ page: "syncWords" });
  unmount(root);
});

test("the connect sheet fits its one task in a 360-point detent that can grow to large, opens large past the root, and has no detents at large text sizes or anywhere else in Settings", () => {
  const fitted = { height: 360 };
  expect(connectDetents([{ page: "syncConnect" }], 1)).toEqual(presentationDetents([fitted, "large"], { selection: fitted }));
  expect(connectDetents([{ page: "syncConnect" }], 1.2)).toEqual(presentationDetents([fitted, "large"], { selection: fitted }));
  expect(connectDetents([{ page: "syncConnect" }, { page: "syncWords" }], 1)).toEqual(presentationDetents([fitted, "large"], { selection: "large" }));
  expect(connectDetents([{ page: "syncConnect" }], 1.3)).toBeNull();
  expect(connectDetents([{ page: "root" }, { page: "syncConnect" }], 1)).toBeNull();
  expect(connectDetents([{ page: "sync" }], 1)).toBeNull();
});

onIos("on iPhone Scan Code presents the scanner as a full-screen cover over the Settings sheet, as main does, instead of pushing a page into the sheet", async () => {
  openSettings({ page: "syncConnect" });
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const connect = () => destination(root, "syncConnect");
  await press(actionTitled(connect(), "Scan Code"));
  expect(settingsNav().stack.at(-1)).toEqual({ page: "syncConnect" });
  expect(root.root.findAll((node) => node.type === Modal)[0]!.props).toMatchObject({ visible: true, presentationStyle: "fullScreen" });
  unmount(root);
});

const PAGE_TITLES: string[] = [CONNECT_WORDS.scanTitle, CONNECT_WORDS.folderTitle];
const root = (rendered: Root) => rendered.root.findAll((node) => typeof node.type === "string" && node.props.name !== "destination" && within(node, (props) => PAGE_TITLES.includes(props.text as string)).length > 0)[0]!;

onIos("opened on its own, as onboarding opens it, the connect page is the stack's root with Cancel instead of Done; Cancel closes Settings", async () => {
  openSettingsPage({ page: "syncConnect" });
  const rendered = renderSurface(<SettingsView />);
  await act(async () => undefined);
  expect(connectIsStackRoot(settingsNav().stack)).toBe(true);
  const page = root(rendered);
  expect(within(page, (props) => props.label === "Cancel")).toHaveLength(1);
  expect(within(rendered.root, (props) => props.text === "Done")).toHaveLength(0);
  await press(byLabel(page, "Cancel"));
  expect(settingsNav().open).toBe(false);
  unmount(rendered);
});

onIos("while connecting, Cancel, Change and the folder action are locked and the page cannot be swiped away, as they are in Settings", async () => {
  jest.spyOn(syncActions, "connectSync").mockReturnValue(new Promise(() => undefined));
  setConnectPhrase(WORDS);
  openSettingsPage({ page: "syncConnect" });
  const rendered = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const page = () => root(rendered);
  expect(disabledOf(byLabel(page(), "Change"))).toBe(false);
  await press(actionTitled(page(), "Choose Folder…"));
  expect(disabledOf(byLabel(page(), "Cancel"))).toBe(true);
  expect(disabledOf(byLabel(page(), "Change"))).toBe(true);
  expect(disabledOf(buttonOf(onlyAction(page())))).toBe(true);
  act(() => closeSettings());
  unmount(rendered);
});

test("pushed from Sync With Mac the connect page keeps Back, not Cancel, and the scanner slides in only without Reduce Motion", () => {
  openSettings({ page: "sync" });
  pushSettings({ page: "syncConnect" });
  expect(connectIsStackRoot(settingsNav().stack)).toBe(false);
  expect(scannerPresentation(false)).toBe("slide");
  expect(scannerPresentation(true)).toBe("fade");
  closeSettings();
});

onIos("while it connects, Choose Folder stays on the page with its name, locked, with Connecting as its busy value, as the other Settings operations do", async () => {
  let finish: (value: never) => void = () => undefined;
  jest.spyOn(syncActions, "connectSync").mockReturnValue(new Promise((resolve) => (finish = resolve)) as never);
  setConnectPhrase(WORDS);
  openSettings({ page: "syncConnect" });
  const rendered = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const connect = () => destination(rendered, "syncConnect");
  const choose = () => actionTitled(connect(), "Choose Folder…");
  expect(disabledOf(choose())).toBe(false);
  await press(choose());
  expect(disabledOf(choose())).toBe(true);
  expect(((choose()!.props.modifiers as { $type: string; value?: string }[]) ?? []).find((modifier) => modifier.$type === "accessibilityValue")?.value).toBe("Connecting…");
  expect(texts(connect())).not.toContain("Connecting…");
  await act(async () => finish({ result: "failed" } as never));
  unmount(rendered);
});

const focusRequestOf = (node: ReactTestInstance) => ((node.props.modifiers as { $type: string; request?: number }[] | undefined) ?? []).find((modifier) => modifier.$type === "ardia.accessibilityFocusRequest")?.request;
const scannerModal = (rendered: Root) => rendered.root.findAll((node) => node.type === Modal)[0]!;
const scanner = (rendered: Root) => rendered.root.findAll((node) => node.type === SyncScan)[0]!;

test("each way out of the iPhone scanner settles focus only once the cover has gone: Cancel back to Scan Code, a scanned code to the phrase it added, Enter Recovery Phrase to the pushed page", () => {
  const none = { scanCode: 0, phraseAdded: 0, pushWords: false };
  expect(afterScanner("cancel", none)).toEqual({ scanCode: 1, phraseAdded: 0, pushWords: false });
  expect(afterScanner("scanned", none)).toEqual({ scanCode: 0, phraseAdded: 1, pushWords: false });
  expect(afterScanner("enterWords", none)).toEqual({ scanCode: 0, phraseAdded: 0, pushWords: true });
  expect(afterScanner(null, { ...none, pushWords: true })).toEqual(none);
  expect(titleWhileBusy("Choose Folder…", "Choose Another Folder…", true)).toBe("Choose Folder…");
  expect(titleWhileBusy("Choose Folder…", "Choose Another Folder…", false)).toBe("Choose Another Folder…");
});

onIos("on iPhone, Cancel and VoiceOver's Escape on the scanner hand focus back to Scan Code after the full-screen cover finishes dismissing, not before", async () => {
  jest.spyOn(scan, "prepareCamera").mockImplementation(async () => "unavailable");
  openSettings({ page: "syncConnect" });
  const rendered = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const connect = () => destination(rendered, "syncConnect");
  const scanCode = () => actionTitled(connect(), "Scan Code");
  expect(focusRequestOf(scanCode())).toBe(0);
  await press(scanCode());
  expect(scannerModal(rendered).props.visible).toBe(true);
  await act(async () => scanner(rendered).props.onCancel());
  expect(scannerModal(rendered).props.visible).toBe(false);
  expect(focusRequestOf(scanCode())).toBe(0);
  await act(async () => scannerModal(rendered).props.onDismiss());
  expect(focusRequestOf(scanCode())).toBe(1);
  await press(scanCode());
  await act(async () => undefined);
  const cover = within(scannerModal(rendered), (props) => props.testID === "syncScanner")[0]!;
  act(() => cover.props.onAccessibilityEscape());
  act(() => jest.runOnlyPendingTimers());
  expect(scannerModal(rendered).props.visible).toBe(false);
  await act(async () => scannerModal(rendered).props.onDismiss());
  expect(focusRequestOf(scanCode())).toBe(2);
  expect(settingsNav().stack.at(-1)).toEqual({ page: "syncConnect" });
  unmount(rendered);
});

onIos("on iPhone a scanned code sends focus to the phrase it added once the cover has gone, and Enter Recovery Phrase pushes its page only after the cover has gone, so the pushed page takes focus", async () => {
  jest.spyOn(scan, "prepareCamera").mockImplementation(async () => "unavailable");
  openSettings({ page: "syncConnect" });
  const rendered = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const connect = () => destination(rendered, "syncConnect");
  await press(actionTitled(connect(), "Scan Code"));
  await act(async () => scanner(rendered).props.onEnterWords());
  expect(settingsNav().stack.at(-1)).toEqual({ page: "syncConnect" });
  await act(async () => scannerModal(rendered).props.onDismiss());
  expect(settingsNav().stack.at(-1)).toEqual({ page: "syncWords" });
  await act(async () => popSettings());
  await press(actionTitled(connect(), "Scan Code"));
  await act(async () => scanner(rendered).props.onScan(WORDS));
  const added = () => within(connect(), (props) => props.title === CONNECT_WORDS.phraseAdded)[0]!;
  expect(focusRequestOf(added())).toBe(0);
  await act(async () => scannerModal(rendered).props.onDismiss());
  expect(focusRequestOf(added())).toBe(1);
  expect(texts(connect())).not.toContain("Scan Code");
  unmount(rendered);
});

onIos("on iPhone, picking the first folder keeps Choose Folder mounted and named as it was while it connects, locked with Connecting as its value and a hidden spinner beside it", async () => {
  const session = createConnectSession({ pickFolder: async () => ({ folder: "/sync", name: "Ardia Sync" }), connect: () => new Promise<{ result: string }>(() => undefined), forgetFolder: async () => undefined }, (phrase) => phrase === WORDS);
  jest.spyOn(syncActions, "canPickSyncFolderFirst").mockReturnValue(true);
  jest.spyOn(syncActions, "syncConnectSession").mockReturnValue(session as never);
  setConnectPhrase(WORDS);
  openSettings({ page: "syncConnect" });
  const rendered = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const connect = () => destination(rendered, "syncConnect");
  const choose = () => actionTitled(connect(), "Choose Folder…");
  const before = choose();
  expect(disabledOf(before)).toBe(false);
  await press(before);
  await act(async () => undefined);
  expect(session.state().connecting).toBe(true);
  expect(texts(connect())).not.toContain("Choose Another Folder…");
  expect(choose().instance).toBe(before.instance);
  expect(disabledOf(choose())).toBe(true);
  expect(((choose().props.modifiers as { $type: string; value?: string }[]) ?? []).find((modifier) => modifier.$type === "accessibilityValue")?.value).toBe("Connecting…");
  const spinners = within(connect(), (props) => ((props.modifiers as { $type: string; hidden?: boolean }[] | undefined) ?? []).some((modifier) => modifier.$type === "accessibilityHidden"));
  expect(spinners.length).toBeGreaterThan(0);
  unmount(rendered);
});

onIos("on iPhone a folder that fails to connect keeps the folder task, puts the error in the subtitle's place in the destructive ink, offers Choose Another Folder, and a corrected phrase from Change connects on its own", async () => {
  const outcomes = [{ result: "mismatch" }, { result: "connected" }];
  const tried: string[] = [];
  const session = createConnectSession(
    {
      pickFolder: async () => ({ folder: "/sync", name: "Ardia Sync" }),
      connect: async (phrase) => {
        tried.push(phrase);
        return outcomes.shift()!;
      },
      forgetFolder: async () => undefined,
    },
    (phrase) => phrase.split(" ").length === 24,
  );
  jest.spyOn(syncActions, "canPickSyncFolderFirst").mockReturnValue(true);
  jest.spyOn(syncActions, "syncConnectSession").mockReturnValue(session as never);
  setConnectPhrase(WORDS);
  openSettings({ page: "syncConnect" });
  const rendered = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const connect = () => destination(rendered, "syncConnect");
  await press(actionTitled(connect(), "Choose Folder…"));
  await act(async () => undefined);
  expect(tried).toEqual([WORDS]);
  const words = texts(connect());
  expect(words[0]).toBe(CONNECT_WORDS.folderTitle);
  expect(words).not.toContain(CONNECT_WORDS.folderHint);
  expect(words[1]).toMatch(/doesn’t match/);
  const error = within(connect(), (props) => props.text === words[1])[0]!;
  expect(JSON.stringify((error.props.modifiers as { $type: string }[]).find((modifier) => modifier.$type === "foregroundStyle"))).toContain(rolesFor(false).destructive);
  actionTitled(connect(), "Choose Another Folder…");
  await press(byLabel(connect(), CONNECT_WORDS.change));
  expect(settingsNav().stack.at(-1)).toEqual({ page: "syncWords" });
  const corrected = WORDS.replace("word0", "fixed0");
  await act(async () => setConnectPhrase(corrected));
  await act(async () => popSettings());
  await act(async () => undefined);
  expect(tried).toEqual([WORDS, corrected]);
  expect(settingsNav().stack.at(-1)).toEqual({ page: "root" });
  unmount(rendered);
});
