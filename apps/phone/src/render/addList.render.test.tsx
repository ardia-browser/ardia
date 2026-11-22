import { act } from "react-test-renderer";
import { FilterListsPage } from "../components/settings/BlockingPages";
import * as settingsActions from "../state/settings/actions";
import { useBlocking } from "../state/settings/actions";
import * as syncActions from "../state/sync/actions";
import { pressButton, renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

let adding: jest.SpyInstance;
let pasting: jest.SpyInstance;
let finishAdd: (refusal: string | null) => void = () => undefined;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useBlocking.setState({ busy: false, state: { isUpdating: false, isOffline: false, lastUpdated: 1, enabledRuleCount: 0, lists: [], myFiltersRuleCount: 0 } as never });
  adding = jest.spyOn(settingsActions, "addList").mockImplementation(
    () =>
      new Promise<string | null>((resolve) => {
        finishAdd = resolve;
      }),
  );
  pasting = jest.spyOn(syncActions, "pastedText").mockImplementation(async () => "  https://lists.example.com/extra.txt ");
});

afterEach(() => {
  adding.mockRestore();
  pasting.mockRestore();
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const field = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.props.accessibilityLabel === "List Address" && typeof node.props.onChangeText === "function")[0]!;
const footer = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.props.testID === "addListFooter" && typeof node.type === "string")[0]!.props.children;
const addButton = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.props.accessibilityRole === "button" && typeof node.props.onPress === "function" && textOf({ root: node } as never) === "Add")[0];

async function openSheet() {
  const root = renderSurface(<FilterListsPage />);
  await pressButton(root, "Add a List");
  act(() => jest.runOnlyPendingTimers());
  return root;
}

test("Add a List is a sheet whose field takes focus, offers Paste while empty and keeps Add off until the address is valid", async () => {
  const root = await openSheet();
  expect(field(root).props.autoFocus).toBe(true);
  expect(addButton(root)!.props.disabled).toBe(true);
  expect(footer(root)).toBe("Adblock Plus or uBlock Origin format.");
  await pressButton(root, "Paste");
  expect(field(root).props.value).toBe("https://lists.example.com/extra.txt");
  expect(addButton(root)!.props.disabled).toBe(false);
  act(() => field(root).props.onChangeText("lists.example.com"));
  expect(footer(root)).toBe("Enter an address that starts with https://.");
  expect(addButton(root)!.props.disabled).toBe(true);
  unmount(root);
});

test("Done adds once, a spinner replaces Add while it runs, and a refusal shows the list's own message", async () => {
  const root = await openSheet();
  act(() => field(root).props.onChangeText("https://lists.example.com/extra.txt"));
  act(() => {
    field(root).props.onSubmitEditing();
    field(root).props.onSubmitEditing();
  });
  expect(adding).toHaveBeenCalledTimes(1);
  expect(root.root.findAll((node) => node.props.testID === "addingList").length).toBeGreaterThan(0);
  await act(async () => finishAdd("This list is already in your lists."));
  expect(footer(root)).toBe("This list is already in your lists.");
  expect(addButton(root)).toBeDefined();
  unmount(root);
});
