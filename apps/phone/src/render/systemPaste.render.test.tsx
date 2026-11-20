import { createElement } from "react";
import { View } from "react-native";
import { act } from "react-test-renderer";
import { FilterListsPage } from "../components/settings/BlockingPages";
import { SyncConnect } from "../components/sync/SyncConnect";
import { useBlocking } from "../state/settings/actions";
import * as syncActions from "../state/sync/actions";
import { pressButton, renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

const pasteModule = require("@ardia/phone-native/src/pasteButton") as typeof import("@ardia/phone-native/src/pasteButton");

type Root = ReturnType<typeof renderSurface>;

let pasting: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useBlocking.setState({ busy: false, state: { isUpdating: false, isOffline: false, lastUpdated: 1, enabledRuleCount: 0, lists: [], myFiltersRuleCount: 0 } as never });
  pasting = jest.spyOn(syncActions, "pastedText").mockImplementation(async () => "otter river stone");
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const withSystemPaste = (on: boolean) => {
  jest.spyOn(pasteModule, "pasteButtonIsNative").mockImplementation(() => on);
  jest.spyOn(pasteModule, "PasteButton").mockImplementation(((props: object) => createElement(View, props)) as never);
};

const systemPaste = (root: Root) => root.root.findAll((node) => node.props.testID === "systemPaste" && typeof node.props.onPaste === "function")[0];
const drawnPaste = (root: Root) => root.root.findAll((node) => node.props.accessibilityRole === "button" && typeof node.props.onPress === "function" && textOf({ root: node } as never) === "Paste");
const fieldValue = (root: Root, label: string) => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onChangeText === "function")[0]!.props.value;

async function enterWords() {
  const root = renderSurface(<SyncConnect onClose={() => undefined} onConnected={() => undefined} />);
  await pressButton(root, "Enter Words");
  act(() => jest.runOnlyPendingTimers());
  return root;
}

async function addListSheet() {
  const root = renderSurface(<FilterListsPage />);
  await pressButton(root, "Add a List");
  act(() => jest.runOnlyPendingTimers());
  return root;
}

test("where the system paste control exists, Enter Words uses it, so iPhone asks no Allow Paste question, and its text fills the words", async () => {
  withSystemPaste(true);
  const root = await enterWords();
  const control = systemPaste(root);
  expect(control).toBeDefined();
  expect(control!.props.accessibilityLabel).toBe("Paste");
  expect(control!.props.style).toEqual(expect.arrayContaining([{ width: 262 / 3, height: 103 / 3 }]));
  expect(drawnPaste(root)).toHaveLength(0);
  act(() => control!.props.onPaste("otter river stone"));
  expect(fieldValue(root, "Recovery Phrase")).toBe("otter river stone");
  expect(pasting).not.toHaveBeenCalled();
  expect(systemPaste(root)).toBeUndefined();
  unmount(root);
});

test("Add a List uses the system paste control too, trimming the address, and empty text changes nothing", async () => {
  withSystemPaste(true);
  const root = await addListSheet();
  const control = systemPaste(root)!;
  act(() => control.props.onPaste("   "));
  expect(fieldValue(root, "List Address")).toBe("");
  act(() => control.props.onPaste("  https://lists.example.com/extra.txt "));
  expect(fieldValue(root, "List Address")).toBe("https://lists.example.com/extra.txt");
  expect(pasting).not.toHaveBeenCalled();
  unmount(root);
});

test("where it is missing, as on Android, both screens keep their own Paste button reading the clipboard", async () => {
  withSystemPaste(false);
  const words = await enterWords();
  expect(systemPaste(words)).toBeUndefined();
  await pressButton(words, "Paste");
  expect(pasting).toHaveBeenCalledTimes(1);
  expect(fieldValue(words, "Recovery Phrase")).toBe("otter river stone");
  unmount(words);
  const list = await addListSheet();
  expect(systemPaste(list)).toBeUndefined();
  expect(drawnPaste(list)).toHaveLength(1);
  unmount(list);
});
