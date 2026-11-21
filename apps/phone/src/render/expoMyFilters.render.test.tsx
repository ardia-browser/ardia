import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { ExpoMyFiltersPage } from "../components/settings/ExpoBlockingPages";
import { renderSurface, unmount } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const hosts = (root: ReturnType<typeof renderSurface>, has: (props: Record<string, unknown>) => boolean) => root.root.findAll((node: ReactTestInstance) => typeof node.type === "string" && has(node.props));
const modifiersOf = (node: ReactTestInstance) => (node.props.modifiers as { $type: string; [key: string]: unknown }[] | undefined) ?? [];

onIos("on iPhone My Filters is main's MyFiltersEditor on the toolkit: the title, main's placeholder over an empty editor, the summary and Filter Syntax below, and Apply off until there is a change", () => {
  const root = renderSurface(<ExpoMyFiltersPage />);
  expect(hosts(root, (props) => modifiersOf({ props } as unknown as ReactTestInstance).some((modifier) => modifier.$type === "navigationTitle" && modifier.title === "My Filters"))).not.toHaveLength(0);
  expect(hosts(root, (props) => typeof props.text === "string" && (props.text as string).startsWith("||ads.example.com^"))).toHaveLength(1);
  expect(hosts(root, (props) => props.text === "No rules yet")).toHaveLength(1);
  expect(hosts(root, (props) => props.label === "Filter Syntax")).toHaveLength(1);
  expect(hosts(root, (props) => props.label === "Revert")).toHaveLength(0);
  const apply = hosts(root, (props) => props.label === "Apply")[0]!;
  expect(modifiersOf(apply).find((modifier) => modifier.$type === "disabled")?.disabled).toBe(true);
  unmount(root);
});
