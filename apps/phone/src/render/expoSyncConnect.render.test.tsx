import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { SettingsView } from "../components/settings/SettingsView";
import { openSettings, settingsNav } from "../state/settings/nav";
import * as syncActions from "../state/sync/actions";
import { setConnectPhrase } from "../state/sync/connectDraft";
import * as scan from "../state/sync/scan";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

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

onIos("on iPhone Connect to Your Mac is main's two steps on Expo UI; Enter Words pushes main's phrase page, whose Use Phrase brings 24 good words back as the first step done", async () => {
  openSettings({ page: "syncConnect" });
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const connect = () => destination(root, "syncConnect");
  expect(texts(connect())).toEqual(expect.arrayContaining(["Show the code on your Mac", "Choose the Ardia Sync folder"]));
  expect(byLabel(connect(), "Scan Code")).toBeTruthy();
  await press(byLabel(connect(), "Enter Words"));
  expect(settingsNav().stack.at(-1)).toEqual({ page: "syncWords" });
  const words = () => destination(root, "syncWords");
  expect(disabledOf(byLabel(words(), "Use Phrase"))).toBe(true);
  const field = within(words(), (props) => props.placeholder === "Enter your 24-word recovery phrase")[0]!;
  await act(async () => field.props.onTextChange({ nativeEvent: { value: WORDS } }));
  expect(disabledOf(byLabel(words(), "Use Phrase"))).toBe(false);
  expect(texts(words())).toContain("24/24 words");
  await press(byLabel(words(), "Use Phrase"));
  expect(settingsNav().stack.at(-1)).toEqual({ page: "syncConnect" });
  expect(within(connect(), (props) => props.title === "Recovery phrase added")).toHaveLength(1);
  expect(byLabel(connect(), "Change")).toBeTruthy();
  unmount(root);
});

onIos("on iPhone Scan Code presents the scanner as a full-screen cover over the Settings sheet, as main does, instead of pushing a page into the sheet", async () => {
  openSettings({ page: "syncConnect" });
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const connect = () => destination(root, "syncConnect");
  await press(byLabel(connect(), "Scan Code"));
  expect(settingsNav().stack.at(-1)).toEqual({ page: "syncConnect" });
  unmount(root);
});
