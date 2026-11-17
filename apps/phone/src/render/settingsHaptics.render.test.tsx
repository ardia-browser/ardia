import { act } from "react-test-renderer";
import { SyncPage } from "../components/sync/SyncPage";
import { haptics } from "../state/app/haptics";
import * as syncActions from "../state/sync/actions";
import { useSync } from "../state/sync/store";
import { status } from "../../test/syncFixture";
import { pressButton, renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

let success: jest.SpyInstance;
let error: jest.SpyInstance;
let warning: jest.SpyInstance;
let syncing: jest.SpyInstance;
let stopping: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useSync.setState((state) => ({ ...state, status: status({ isEnabled: true, phase: "updated" }) }));
  success = jest.spyOn(haptics, "success").mockImplementation(() => undefined);
  error = jest.spyOn(haptics, "error").mockImplementation(() => undefined);
  warning = jest.spyOn(haptics, "warning").mockImplementation(() => undefined);
  syncing = jest.spyOn(syncActions, "syncNow");
  stopping = jest.spyOn(syncActions, "stopSyncing").mockImplementation(async () => undefined);
});

afterEach(() => {
  for (const spy of [success, error, warning, syncing, stopping]) spy.mockRestore();
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const syncEndsIn = (phase: "updated" | "offline" | "updating") =>
  syncing.mockImplementation(async () => {
    useSync.setState((state) => ({ ...state, status: status({ isEnabled: true, phase }) }));
  });

test("Sync Now taps success when the sync lands", async () => {
  syncEndsIn("updated");
  const root = renderSurface(<SyncPage />);
  await pressButton(root, "Sync Now");
  expect(success).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
  unmount(root);
});

test("Sync Now taps an error when the phone is offline", async () => {
  syncEndsIn("offline");
  const root = renderSurface(<SyncPage />);
  await pressButton(root, "Sync Now");
  expect(error).toHaveBeenCalledTimes(1);
  expect(success).not.toHaveBeenCalled();
  unmount(root);
});

test("confirming Stop Syncing taps a warning", async () => {
  const root = renderSurface(<SyncPage />);
  await pressButton(root, "Stop Syncing…");
  const confirm = root.root.findAll((node) => typeof node.props.onPress === "function" && textOf({ root: node } as never) === "Stop Syncing")[0];
  expect(confirm).toBeDefined();
  await act(async () => confirm!.props.onPress());
  expect(warning).toHaveBeenCalledTimes(1);
  expect(stopping).toHaveBeenCalledTimes(1);
  unmount(root);
});
