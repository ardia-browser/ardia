import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { SyncConnect } from "../components/sync/SyncConnect";
import { pressButton, renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

test("Enter Words is pushed over the connect page, which stays beneath and hidden from screen readers, and its counter and footer crossfade", async () => {
  const root = renderSurface(<SyncConnect onClose={() => undefined} onConnected={() => undefined} />);
  await pressButton(root, "Enter Words");
  act(() => jest.runOnlyPendingTimers());
  expect(root.root.findAll((node) => node.props.testID === "enterWordsPushed" && typeof node.type === "string")).toHaveLength(1);
  expect(textOf(root)).toContain("Connect to Your Mac");
  const hidden = root.root.findAll((node) => typeof node.type === "string" && node.props.importantForAccessibility === "no-hide-descendants" && node.props.accessibilityElementsHidden === true);
  expect(hidden.some((node) => textOf({ root: node } as never).includes("Two Steps"))).toBe(true);
  for (const id of ["phraseCounter", "phraseFooter"]) {
    const animated = root.root.findAll((candidate) => candidate.props.testID === id && candidate.props.entering !== undefined && candidate.props.exiting !== undefined);
    expect(animated.length).toBeGreaterThan(0);
  }
  unmount(root);
});

test("the phrase field takes each platform's keyboard: ASCII on iPhone, dismissed by a drag, and Android's visible-password keyboard", async () => {
  const root = renderSurface(<SyncConnect onClose={() => undefined} onConnected={() => undefined} />);
  await pressButton(root, "Enter Words");
  act(() => jest.runOnlyPendingTimers());
  const field = root.root.findAll((node) => node.props.accessibilityLabel === "Recovery Phrase" && typeof node.props.onChangeText === "function")[0]!;
  expect(field.props.keyboardType).toBe(Platform.OS === "ios" ? "ascii-capable" : "visible-password");
  const scrolls = root.root.findAll((node) => typeof node.props.keyboardDismissMode === "string");
  expect(scrolls.some((node) => node.props.keyboardDismissMode === (Platform.OS === "ios" ? "on-drag" : "none"))).toBe(true);
  unmount(root);
});
