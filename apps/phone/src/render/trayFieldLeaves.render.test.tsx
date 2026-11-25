import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { SearchTray } from "../components/search/SearchTray";
import { DesignProvider } from "../components/ui";
import type { Design } from "../lib/design";
import { dismissSearch, presentSearch, useSearch } from "../state/search/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const editableFields = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => (node.type === "TextInput" || node.type === ("ArdiaPhoneCompletingField" as never)) && typeof node.type === "string");

for (const design of ["redesigned", "original"] as Design[]) {
  test(`in the ${design} design, once the tray starts to leave it holds no editable field, so nothing hidden keeps focus or a blinking caret; the words typed stay on show while it leaves`, () => {
    act(() => presentSearch("page", "otters"));
    const root = renderSurface(
      <DesignProvider design={design}>
        <SearchTray />
      </DesignProvider>,
    );
    act(() => jest.advanceTimersByTime(600));
    expect(editableFields(root).length).toBe(1);
    act(() => dismissSearch());
    act(() => jest.advanceTimersByTime(16));
    expect(editableFields(root)).toHaveLength(0);
    const leaving = root.root.findAll((node) => node.props.testID === "trayFieldLeaving" && typeof node.type === "string");
    expect(leaving).toHaveLength(1);
    expect(leaving[0]!.props.children).toBe("otters");
    act(() => jest.advanceTimersByTime(2000));
    expect(editableFields(root)).toHaveLength(0);
    unmount(root);
  });
}

for (const design of ["redesigned", "original"] as Design[]) {
  test(`in the ${design} design, the tray's root is a real view from the start, so turning its touches off at submit doesn't make a new host view and remount the leaving panel`, () => {
    act(() => presentSearch("page", "otters"));
    const root = renderSurface(
      <DesignProvider design={design}>
        <SearchTray />
      </DesignProvider>,
    );
    act(() => jest.advanceTimersByTime(600));
    const trayRoot = () => root.root.findAll((node) => node.props.testID === "trayRoot" && typeof node.type === "string");
    expect(trayRoot()).toHaveLength(1);
    expect(trayRoot()[0]!.props.collapsable).toBe(false);
    expect(trayRoot()[0]!.props.pointerEvents).toBe("box-none");
    act(() => dismissSearch());
    act(() => jest.advanceTimersByTime(16));
    expect(trayRoot()[0]!.props.collapsable).toBe(false);
    expect(trayRoot()[0]!.props.pointerEvents).toBe("none");
    unmount(root);
  });
}

test("a screen reader closes search from Close Search itself, without a touch reaching the dim: VoiceOver's double tap on iPhone, TalkBack's activate on Android", () => {
  act(() => presentSearch("page", "otters"));
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  act(() => jest.advanceTimersByTime(600));
  const close = root.root.findAll((node) => node.props.accessibilityLabel === "Close Search" && typeof node.type !== "string")[0]!;
  expect(useSearch.getState().open).toBe(true);
  if (Platform.OS === "ios") act(() => close.props.onAccessibilityTap());
  else act(() => close.props.onAccessibilityAction({ nativeEvent: { actionName: "activate" } }));
  expect(useSearch.getState().open).toBe(false);
  unmount(root);
});
