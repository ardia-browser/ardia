import { Platform } from "react-native";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { ListRow } from "../components/library/listSheet";
import { listRowLayout } from "../components/library/listSheetTokens";

jest.mock("@ardia/phone-native/src/settingsUI", () => ({
  ...jest.requireActual<object>("@ardia/phone-native/src/settingsUI"),
  onWidthChange: (handler: (width: number) => void) => ({ $type: "ardia.widthChange", eventListener: (args: { width: number }) => handler(args.width) }),
}));

const onIos = Platform.OS === "ios" ? test : test.skip;

type Modifier = { $type: string; limit?: number; eventListener?: (args: unknown) => void };

const modifiersOf = (node: ReactTestInstance) => (node.props.modifiers as Modifier[] | undefined) ?? [];
const titleOf = (root: ReactTestRenderer) => root.root.findAll((node) => typeof node.type === "string" && modifiersOf(node).some((modifier) => modifier.$type === "ardia.widthChange"))[0]!;
const linesOf = (root: ReactTestRenderer) => modifiersOf(titleOf(root)).find((modifier) => modifier.$type === "lineLimit")?.limit;

onIos("a native list row measures its title's own width and gives a narrow row a second line at an ordinary text size, then takes it back when the row widens", () => {
  let root: ReactTestRenderer | undefined;
  act(() => {
    root = create(<ListRow title="A long page title that needs room" leading={{ symbol: "doc" }} hint="Opens the page." onPress={() => undefined} />);
  });
  expect(linesOf(root!)).toBe(listRowLayout.titleLines);
  const report = (width: number) => act(() => modifiersOf(titleOf(root!)).find((modifier) => modifier.$type === "ardia.widthChange")!.eventListener!({ width }));
  report(listRowLayout.narrowTitleWidth - 40);
  expect(linesOf(root!)).toBe(listRowLayout.narrowTitleLines);
  report(listRowLayout.narrowTitleWidth + 80);
  expect(linesOf(root!)).toBe(listRowLayout.titleLines);
  act(() => root!.unmount());
});
