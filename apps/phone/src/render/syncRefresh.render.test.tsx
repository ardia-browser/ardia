import { act } from "react-test-renderer";
import { SyncPage } from "../components/sync/SyncPage";
import * as syncActions from "../state/sync/actions";
import { useSync } from "../state/sync/store";
import { status } from "../../test/syncFixture";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

let syncing: jest.SpyInstance;
let finishSync: () => void = () => undefined;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  syncing = jest.spyOn(syncActions, "syncNow").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishSync = resolve;
      }),
  );
});

afterEach(() => {
  syncing.mockRestore();
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const refreshControl = (root: ReturnType<typeof renderSurface>) =>
  root.root.findAll((node) => node.props.refreshControl !== undefined && node.props.refreshControl !== null)[0]?.props.refreshControl;

test("with sync on, pulling the Sync page runs a sync cycle and spins until it ends, as Compose's PullToRefreshBox", async () => {
  useSync.setState((state) => ({ ...state, status: status({ isEnabled: true, phase: "updated" }) }));
  const root = renderSurface(<SyncPage />);
  expect(refreshControl(root)).toBeDefined();
  act(() => refreshControl(root).props.onRefresh());
  expect(syncing).toHaveBeenCalledTimes(1);
  expect(refreshControl(root).props.refreshing).toBe(true);
  await act(async () => finishSync());
  expect(refreshControl(root).props.refreshing).toBe(false);
  unmount(root);
});

test("with sync off, the Sync page doesn't pull to refresh", () => {
  useSync.setState((state) => ({ ...state, status: status({ isEnabled: false, phase: "off" }) }));
  const root = renderSurface(<SyncPage />);
  expect(refreshControl(root)).toBeUndefined();
  unmount(root);
});
