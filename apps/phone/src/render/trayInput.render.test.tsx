import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act } from "react-test-renderer";
import { SearchTray } from "../components/search/SearchTray";
import * as browse from "../state/browse/store";
import { presentSearch, useSearch } from "../state/search/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";
import { useTabs } from "../state/tabs/store";

const telemetry = require("../state/telemetry/telemetry") as typeof import("../state/telemetry/telemetry");

const mockField = { native: true, setText: [] as [string, boolean][], focused: 0, blurred: 0 };

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual("@ardia/phone-native");
  const { forwardRef, useImperativeHandle, createElement } = jest.requireActual("react");
  const { View } = jest.requireActual("react-native");
  const CompletingField = forwardRef(function CompletingField(props: Record<string, unknown>, ref: unknown) {
    useImperativeHandle(ref, () => ({
      focus: () => (mockField.focused += 1),
      blur: () => (mockField.blurred += 1),
      setText: (text: string, selectsAll: boolean) => mockField.setText.push([text, selectsAll]),
    }));
    return createElement(View, { ...props, testID: "completingField" });
  });
  return { ...actual, CompletingField, completingFieldIsNative: () => mockField.native };
});

function field(root: ReturnType<typeof renderSurface>) {
  return root.root.findAll((node) => node.props.testID === "completingField" && typeof node.props.onTypedChange === "function")[0];
}

function plainField(root: ReturnType<typeof renderSurface>) {
  return root.root.findAll((node) => node.type === "TextInput")[0];
}

function labels(root: ReturnType<typeof renderSurface>) {
  return root.root.findAll((node) => typeof node.props.accessibilityLabel === "string" && typeof node.props.onPress === "function").map((node) => node.props.accessibilityLabel as string);
}

let submit: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  mockField.native = true;
  mockField.setText = [];
  mockField.focused = 0;
  mockField.blurred = 0;
  submit = jest.spyOn(browse, "submitSearch").mockImplementation(() => true);
  withTabs(1);
  browse.useBrowse.setState({ surface: "start" });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  submit.mockRestore();
  jest.useRealTimers();
});

test("where the native field exists the tray uses it, with today's placeholder, keyboard and label, and focuses it", () => {
  presentSearch("start", "");
  const root = renderSurface(<SearchTray />);
  const native = field(root);
  expect(native).toBeDefined();
  expect(plainField(root)).toBeUndefined();
  expect(native!.props).toMatchObject({ placeholder: "Search…", accessibilityLabel: "Search or Enter Address", keyboardType: "web-search", returnKeyType: "go", autoCorrect: false, autoCapitalize: "none" });
  expect(mockField.focused).toBeGreaterThan(0);
  unmount(root);
});

test("typing offers the omnibox's completion after the typed text, highlighted in the accent at 30%", () => {
  presentSearch("start", "");
  const root = renderSurface(<SearchTray />);
  act(() => field(root)!.props.onTypedChange("goo"));
  act(() => useSearch.setState({ completion: "gle.com", completedFor: "goo" }));
  expect(field(root)!.props.offer).toEqual({ query: "goo", completion: "google.com" });
  expect(field(root)!.props.highlightColor).toMatch(/^rgba\(\d+, \d+, \d+, 0\.3\)$/);
  act(() => useSearch.setState({ completion: "ogle.com", completedFor: "go" }));
  expect(field(root)!.props.offer).toEqual({ query: "go", completion: "google.com" });
  unmount(root);
});

test("Go submits what the field shows, completion included", () => {
  presentSearch("start", "");
  const root = renderSurface(<SearchTray />);
  act(() => field(root)!.props.onSubmit("google.com"));
  expect(submit).toHaveBeenCalledWith("google.com");
  unmount(root);
});

test("opening the tray on a page's address selects all of it", () => {
  presentSearch("page", "https://example.com/otters");
  const root = renderSurface(<SearchTray />);
  expect(mockField.setText).toEqual([["https://example.com/otters", true]]);
  unmount(root);
});

test("the incognito toggle sits beside the field, and Clear Text replaces the mic once there is text", () => {
  presentSearch("start", "");
  const root = renderSurface(<SearchTray />);
  expect(labels(root).some((label) => /Incognito/.test(label))).toBe(true);
  expect(labels(root)).not.toContain("Clear Text");
  act(() => field(root)!.props.onTypedChange("otters"));
  expect(labels(root)).toContain("Clear Text");
  expect(labels(root)).not.toContain("Voice Search");
  unmount(root);
});

test("where the native field doesn't exist the tray keeps today's input, and it types and submits the same way", () => {
  mockField.native = false;
  presentSearch("start", "");
  const root = renderSurface(<SearchTray />);
  expect(field(root)).toBeUndefined();
  const plain = plainField(root)!;
  expect(plain.props).toMatchObject({ placeholder: "Search…", accessibilityLabel: "Search or Enter Address", keyboardType: "web-search", returnKeyType: "go" });
  act(() => plain.props.onChangeText("otters"));
  act(() => jest.advanceTimersByTime(50));
  expect(useSearch.getState().text).toBe("otters");
  act(() => plain.props.onSubmitEditing({ nativeEvent: { text: "otters" } }));
  expect(submit).toHaveBeenCalledWith("otters");
  unmount(root);
});

test("a submit counts once per tray, however many times it arrives (a hardware Enter fires the field's submit and a key event)", () => {
  presentSearch("start", "");
  const root = renderSurface(<SearchTray />);
  act(() => {
    field(root)!.props.onSubmit("goo");
    field(root)!.props.onSubmit("goo");
  });
  expect(submit).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("a submit that opens nothing leaves the next one free", () => {
  submit.mockImplementationOnce(() => false);
  presentSearch("start", "");
  const root = renderSurface(<SearchTray />);
  act(() => field(root)!.props.onSubmit("   "));
  act(() => field(root)!.props.onSubmit("goo"));
  expect(submit).toHaveBeenCalledTimes(2);
  unmount(root);
});

test("closing the tray blurs the native field itself, since React Native's Keyboard.dismiss only reaches its own text inputs", () => {
  presentSearch("start", "");
  const root = renderSurface(<SearchTray />);
  expect(mockField.blurred).toBe(0);
  act(() => browse.cancelSearch());
  expect(mockField.blurred).toBeGreaterThan(0);
  unmount(root);
});

test("a drag down that lets the keyboard go blurs the native field too, so the keyboard doesn't stay up over the page", () => {
  const cancel = jest.spyOn(browse, "cancelSearch").mockImplementation(() => undefined);
  presentSearch("start", "");
  const root = renderSurface(<SearchTray />);
  act(() =>
    fireGestureHandler(getByGestureTestId("trayDismissDrag"), [
      { state: State.BEGAN, translationY: 0, velocityY: 0 },
      { state: State.ACTIVE, translationY: 0, velocityY: 0 },
      { state: State.ACTIVE, translationY: 120, velocityY: 900 },
    ]),
  );
  act(() => jest.runOnlyPendingTimers());
  expect(mockField.blurred).toBeGreaterThan(0);
  cancel.mockRestore();
  unmount(root);
});

test("a swipe that scrolls the address is counted, and never from an Incognito tab", () => {
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  presentSearch("start", "");
  const root = renderSurface(<SearchTray />);
  act(() => field(root)!.props.onFieldScroll());
  expect(counted).toHaveBeenCalledWith("address_field_scrolled");
  counted.mockClear();
  act(() => useTabs.setState({ incognito: true }));
  act(() => field(root)!.props.onFieldScroll());
  expect(counted).not.toHaveBeenCalled();
  act(() => useTabs.setState({ incognito: false }));
  counted.mockRestore();
  unmount(root);
});
