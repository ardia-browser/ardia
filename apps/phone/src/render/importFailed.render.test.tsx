import { act } from "react-test-renderer";
import { ImportFailedView } from "../components/upgrade/ImportFailedView";
import { bootApp, retryImport, useBoot } from "../state/app/boot";
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

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("a failed Try Again leaves the button ready again, never stuck announcing a retry", async () => {
  act(() => bootApp(() => undefined));
  await act(async () => mockImport.resolve({ kind: "failed", reason: "source" }));
  expect(useBoot.getState()).toMatchObject({ ready: false, busy: false, failures: 1 });
  const root = renderSurface(<ImportFailedView />);
  expect(tryAgain(root).props.accessibilityLabel).toBe("Try Again");
  act(() => retryImport());
  expect(tryAgain(root).props.accessibilityLabel).toBe("Trying Again…");
  expect(tryAgain(root).props.accessibilityState).toEqual({ disabled: true });
  await act(async () => mockImport.resolve({ kind: "failed", reason: "source" }));
  expect(useBoot.getState()).toMatchObject({ busy: false, failures: 2 });
  expect(tryAgain(root).props.accessibilityLabel).toBe("Try Again");
  expect(tryAgain(root).props.accessibilityState).toEqual({ disabled: false });
  expect(textOf(root)).toContain("Start Without Them");
  unmount(root);
});
