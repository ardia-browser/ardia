import { act } from "react-test-renderer";
import { SpacesView } from "../components/sync/SpacesView";
import { haptics } from "../state/app/haptics";
import * as syncActions from "../state/sync/actions";
import * as telemetry from "../state/telemetry/telemetry";
import { useSync } from "../state/sync/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const profile = (syncId: string, name: string) => ({ syncId, name, color: null, icon: null, isDefault: syncId === "work", theme: null, deviceTabs: [], pinned: { tiles: [], sections: [] }, bookmarks: [], history: [], sendTargets: null });

let select: jest.SpyInstance;
let tick: jest.SpyInstance;
let counted: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useSync.setState((state) => ({
    ...state,
    status: { ...state.status, isEnabled: true, phase: "idle" } as never,
    view: { devices: [], profiles: [profile("work", "Work"), profile("home", "Home")], search: null, syncedAt: 1, selectedProfileId: "work", shownProfileId: "work" } as never,
  }));
  select = jest.spyOn(syncActions, "selectProfile").mockImplementation(() => undefined);
  tick = jest.spyOn(haptics, "selection").mockImplementation(() => undefined);
  counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
});

afterEach(() => {
  select.mockRestore();
  tick.mockRestore();
  counted.mockRestore();
  jest.useRealTimers();
});

function pager(root: ReturnType<typeof renderSurface>) {
  return root.root.findAll((node) => node.props.testID === "spacesPager" && typeof node.props.onMomentumScrollEnd === "function")[0]!;
}

test("Spaces swipes between profiles: settling on the next page selects that profile with a tick", () => {
  const root = renderSurface(<SpacesView />);
  act(() => pager(root).props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 393, height: 700 } } }));
  act(() => pager(root).props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 393, y: 0 } } }));
  expect(select).toHaveBeenCalledWith("home");
  expect(tick).toHaveBeenCalledTimes(1);
  expect(counted).toHaveBeenCalledWith("spaces_swiped");
  act(() => pager(root).props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 393, y: 0 } } }));
  expect(select).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("each profile is its own page, and the switcher's tap selects with the same tick", () => {
  const root = renderSurface(<SpacesView />);
  act(() => pager(root).props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 393, height: 700 } } }));
  expect(pager(root).props.data.map((p: { syncId: string }) => p.syncId)).toEqual(["work", "home"]);
  const home = root.root.findAll((node) => node.props.accessibilityLabel === "Home" && typeof node.props.onPress === "function")[0]!;
  act(() => home.props.onPress());
  expect(select).toHaveBeenCalledWith("home");
  expect(tick).toHaveBeenCalledTimes(1);
  expect(counted).not.toHaveBeenCalled();
  unmount(root);
});
