import { act } from "react-test-renderer";
import { ImportFailedView } from "../components/upgrade/ImportFailedView";
import { bootApp, retryImport, useBoot } from "../state/app/boot";
import { StyleSheet } from "react-native";
import { renderSurface, textOf, unmount } from "../../test/render/harness";

const mockImport = { resolve: (_result: { kind: "failed"; reason: "source" }) => undefined as void };

jest.mock("../state/legacy/upgrade", () => ({
  importOldApp: () => new Promise((done) => (mockImport.resolve = done)),
  startWithoutOldApp: async () => false,
  offersStartWithout: () => true,
}));

function tryAgain(root: ReturnType<typeof renderSurface>) {
  return root.root.findAll((node) => node.props.accessibilityRole === "button" && typeof node.props.onPress === "function" && /Try/.test(String(node.props.accessibilityLabel)))[0]!;
}

function startWithout(root: ReturnType<typeof renderSurface>) {
  return root.root.findAll((node) => node.props.accessibilityRole === "button" && typeof node.props.onPress === "function" && node.props.accessibilityLabel === "Start Without Them")[0]!;
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("a failed Try Again leaves the button ready again; while it runs the shared busy state keeps the name, blocks a second press and holds Start Without Them", async () => {
  act(() => bootApp(() => undefined));
  await act(async () => mockImport.resolve({ kind: "failed", reason: "source" }));
  expect(useBoot.getState()).toMatchObject({ ready: false, busy: false, failures: 1 });
  const root = renderSurface(<ImportFailedView />);
  expect(tryAgain(root).props.accessibilityLabel).toBe("Try Again");
  act(() => retryImport());
  expect(tryAgain(root).props.accessibilityLabel).toBe("Try Again");
  expect(tryAgain(root).props.accessibilityState).toEqual({ disabled: true, busy: true });
  expect(root.root.findAll((node) => node.props.testID === "importRetryBusy").length).toBeGreaterThan(0);
  await act(async () => mockImport.resolve({ kind: "failed", reason: "source" }));
  expect(useBoot.getState()).toMatchObject({ busy: false, failures: 2 });
  expect(tryAgain(root).props.accessibilityLabel).toBe("Try Again");
  expect(tryAgain(root).props.accessibilityState).toEqual({ disabled: false, busy: false });
  expect(textOf(root)).toContain("Start Without Them");
  expect(startWithout(root).props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));
  act(() => retryImport());
  expect(startWithout(root).props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
  await act(async () => mockImport.resolve({ kind: "failed", reason: "source" }));
  unmount(root);
});

test("the import failure sits on the neutral app surface, not the profile's colour, with an outlined Retry and a plain Start Without Them", async () => {
  act(() => useBoot.setState({ busy: false, failures: 2 }));
  const root = renderSurface(<ImportFailedView />);
  const screen = root.root.findAll((node) => node.props.testID === "importFailed" && node.props.style)[0]!;
  const fill = StyleSheet.flatten(screen.props.style).backgroundColor;
  const { useTheme } = jest.requireActual("../components/ui") as typeof import("../components/ui");
  let theme: ReturnType<typeof useTheme> | null = null;
  function Probe() {
    theme = useTheme();
    return null;
  }
  const probe = renderSurface(<Probe />);
  expect(fill).toBe(theme!.appSurface);
  expect(fill).not.toBe(theme!.canvas);
  const retryEdge = StyleSheet.flatten(tryAgain(root).props.style({ pressed: false })).borderWidth;
  expect(retryEdge).toBeGreaterThan(0);
  expect(StyleSheet.flatten(startWithout(root).props.style({ pressed: false })).borderWidth).toBe(0);
  unmount(probe);
  unmount(root);
});
