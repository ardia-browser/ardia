import { StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { SyncScan } from "../components/sync/SyncScan";
import { Portal } from "../components/ui";
import * as scan from "../state/sync/scan";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const open = async (access: "granted" | "unavailable" | "denied") => {
  jest.spyOn(scan, "prepareCamera").mockImplementation(async () => access);
  const root = renderSurface(<SyncScan onScan={() => undefined} onEnterWords={() => undefined} onCancel={() => undefined} />);
  await act(async () => {});
  return root;
};

test("the scanner covers the whole screen from the overlay, not the sheet, and frames the code with Compose's four corner arms instead of a rounded border", async () => {
  const root = await open("granted");
  const layer = root.root.findAll((node) => typeof node.type === "string" && node.props.collapsable === false && node.props.pointerEvents === "box-none")[0]!;
  expect(layer.findAll((node) => node.props.testID === "syncScanner" && typeof node.type === "string")).toHaveLength(1);
  const scanner = root.root.findAll((node) => node.type === SyncScan)[0]!;
  expect(scanner.findAll((node) => node.type === Portal)[0]!.children).toHaveLength(0);
  const bordered = root.root.findAll((node) => typeof node.type === "string" && (StyleSheet.flatten(node.props.style)?.borderWidth ?? 0) > 0);
  expect(bordered).toHaveLength(0);
  const finder = root.root.findAll((node) => node.props.testID === "scanFinder")[0]!;
  const path = finder.findAll((node) => typeof node.props.d === "string")[0]!;
  expect((path.props.d as string).match(/M/g)).toHaveLength(4);
  expect(path.props.strokeLinecap).toBe("round");
  unmount(root);
});

test("without a camera the screen shows the QR viewfinder symbol, and without permission the gear, both at 85% white", async () => {
  const unavailable = await open("unavailable");
  const icon = (root: Awaited<ReturnType<typeof open>>) => root.root.findAll((node) => typeof node.props.name === "string" && node.props.size === 48 && typeof node.type !== "string")[0]!;
  expect(icon(unavailable).props.name).toBe("qrcodeViewfinder");
  expect(icon(unavailable).props.color).toBe("rgba(255,255,255,0.85)");
  unmount(unavailable);
  const denied = await open("denied");
  expect(icon(denied).props.name).toBe("gearshape");
  unmount(denied);
});

test("Not an Ardia sync code fades in with the native apps' fade instead of popping", async () => {
  const root = await open("granted");
  expect(root.root.findAll((node) => node.props.testID === "scanRejected")).toHaveLength(0);
  const camera = root.root.findAll((node) => typeof node.props.onRejected === "function")[0]!;
  act(() => camera.props.onRejected());
  const note = root.root.findAll((node) => node.props.testID === "scanRejected" && node.props.entering !== undefined)[0]!;
  expect(note.props.entering).toBeDefined();
  expect(note.props.exiting).toBeDefined();
  expect(textOf({ root: note } as never)).toBe("Not an Ardia sync code.");
  unmount(root);
});
