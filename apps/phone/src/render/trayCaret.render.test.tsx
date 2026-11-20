import { act } from "react-test-renderer";

const core = require("expo-modules-core") as { requireOptionalNativeModule: (name: string) => unknown; requireNativeViewManager: (name: string) => unknown };
const realOptional = core.requireOptionalNativeModule;
const realView = core.requireNativeViewManager;
const { forwardRef, useImperativeHandle, createElement } = require("react") as typeof import("react");
const NativeField = forwardRef(function NativeField(props: Record<string, unknown>, ref) {
  useImperativeHandle(ref, () => ({ focus: () => undefined, blur: () => undefined, setText: () => undefined }));
  return createElement("ArdiaPhoneCompletingField", props);
});
jest.spyOn(core, "requireOptionalNativeModule").mockImplementation((name: string) => (name === "ArdiaPhoneCompletingField" ? {} : realOptional(name)));
jest.spyOn(core, "requireNativeViewManager").mockImplementation((name: string) => (name === "ArdiaPhoneCompletingField" ? NativeField : realView(name)));

const { nativeFieldColor } = require("@ardia/phone-native/src/completingField") as typeof import("@ardia/phone-native/src/completingField");
const { SearchTray } = require("../components/search/SearchTray") as typeof import("../components/search/SearchTray");
const { useTheme } = require("../components/ui") as typeof import("../components/ui");
const { withAlpha } = require("../lib/color") as typeof import("../lib/color");
const browse = require("../state/browse/store") as typeof import("../state/browse/store");
const { presentSearch } = require("../state/search/store") as typeof import("../state/search/store");
const { renderSurface, unmount, withTabs } = require("../../test/render/harness") as typeof import("../../test/render/harness");

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  browse.useBrowse.setState({ surface: "browsing" });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

test("the completing field's caret is the accent and its selection the accent at 30%, not the system's teal", () => {
  let accent = "";
  function Accent() {
    accent = useTheme().formAccent;
    return null;
  }
  presentSearch("page", "");
  const root = renderSurface(
    <>
      <Accent />
      <SearchTray />
    </>,
  );
  const field = root.root.findAll((node) => node.type === ("ArdiaPhoneCompletingField" as never))[0]!;
  expect(field).toBeDefined();
  expect(field.props.cursorColor).toEqual(nativeFieldColor(accent));
  expect(field.props.selectionColor).toEqual(nativeFieldColor(withAlpha(accent, 0.3)));
  expect(field.props.cursorColor).not.toBeUndefined();
  unmount(root);
});
