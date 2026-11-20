import { BackHandler, Keyboard, StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { MyFiltersPage } from "../components/settings/BlockingPages";
import * as settingsActions from "../state/settings/actions";
import { useBlocking } from "../state/settings/actions";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

let applying: jest.SpyInstance;
let dismissing: jest.SpyInstance;
let finishApply: () => void = () => undefined;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useBlocking.setState({ busy: false, state: { myFilters: "||ads.example^", myFiltersRuleCount: 1, myFiltersSkippedCount: 0, lists: [] } as never });
  applying = jest.spyOn(settingsActions, "applyMyFilters").mockImplementation(
    () =>
      new Promise((resolve) => {
        finishApply = () => resolve(null);
      }),
  );
  dismissing = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => undefined);
});

afterEach(() => {
  applying.mockRestore();
  dismissing.mockRestore();
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const field = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.props.testID === "myFiltersField" && typeof node.props.onChangeText === "function")[0]!;
const buttonTitled = (root: ReturnType<typeof renderSurface>, title: string) =>
  root.root.findAll((node) => node.props.accessibilityRole === "button" && typeof node.props.onPress === "function" && textOf({ root: node } as never) === title)[0];

test("the editor fills the page, and unapplied edits hold Back until they are applied or reverted, as Compose", () => {
  const listening = jest.spyOn(BackHandler, "addEventListener");
  const root = renderSurface(<MyFiltersPage />);
  const editor = root.root.findAll((node) => typeof node.type === "string" && node.findAll((inner) => inner.props.testID === "myFiltersField").length > 0 && StyleSheet.flatten(node.props.style)?.flex === 1);
  expect(editor.length).toBeGreaterThan(0);
  expect(root.root.findAll((node) => node.props.accessibilityLabel === "Back" && typeof node.props.onPress === "function")).toHaveLength(1);
  act(() => field(root).props.onChangeText("||ads.example^\n||more.example^"));
  expect(root.root.findAll((node) => node.props.accessibilityLabel === "Back" && typeof node.props.onPress === "function")).toHaveLength(0);
  const backs = listening.mock.calls.filter((call) => call[0] === "hardwareBackPress");
  expect(backs.length).toBeGreaterThan(0);
  expect(backs.at(-1)![1]({ type: "hardwareBackPress", timeStamp: 0 })).toBe(true);
  listening.mockRestore();
  act(() => buttonTitled(root, "Revert")!.props.onPress());
  expect(root.root.findAll((node) => node.props.accessibilityLabel === "Back" && typeof node.props.onPress === "function")).toHaveLength(1);
  unmount(root);
});

test("Apply runs once with a spinner in its place, then puts the keyboard away", async () => {
  const root = renderSurface(<MyFiltersPage />);
  act(() => field(root).props.onChangeText("||ads.example^\n||more.example^"));
  const apply = buttonTitled(root, "Apply")!;
  act(() => {
    apply.props.onPress();
    apply.props.onPress();
  });
  expect(applying).toHaveBeenCalledTimes(1);
  expect(root.root.findAll((node) => node.props.testID === "applyingFilters").length).toBeGreaterThan(0);
  await act(async () => finishApply());
  expect(dismissing).toHaveBeenCalledTimes(1);
  expect(buttonTitled(root, "Apply")).toBeDefined();
  unmount(root);
});
