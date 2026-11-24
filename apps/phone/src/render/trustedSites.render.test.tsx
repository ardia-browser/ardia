import { act } from "react-test-renderer";
import { TrustedSitesPage } from "../components/settings/BlockingPages";
import * as settingsActions from "../state/settings/actions";
import { useBlocking } from "../state/settings/actions";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

let trusting: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useBlocking.setState({ busy: false, state: { exemptHosts: ["zeta.example", "alpha.example"], lists: [] } as never });
  trusting = jest.spyOn(settingsActions, "trustSite").mockImplementation(() => undefined);
});

afterEach(() => {
  trusting.mockRestore();
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const removeButtons = (root: ReturnType<typeof renderSurface>) =>
  root.root.findAll((node) => node.props.accessibilityRole === "button" && /^Remove /.test(node.props.accessibilityLabel ?? "") && typeof node.props.onPress === "function");
const barButton = (root: ReturnType<typeof renderSurface>, title: string) =>
  root.root.findAll((node) => node.props.accessibilityRole === "button" && typeof node.props.onPress === "function" && textOf({ root: node } as never) === title)[0];

test("Trusted Sites lists hosts in order with a globe, hides removal until Edit, and every row keeps a Remove action for screen readers", () => {
  const root = renderSurface(<TrustedSitesPage />);
  const rows = root.root.findAll((node) => typeof node.type === "string" && /^trusted:/.test(node.props.testID ?? ""));
  expect(rows.map((row) => row.props.testID)).toEqual(["trusted:alpha.example", "trusted:zeta.example"]);
  expect(removeButtons(root)).toHaveLength(0);
  const removeName = require("react-native").Platform.OS === "ios" ? "Remove zeta.example" : "remove";
  act(() => rows[1]!.props.onAccessibilityAction({ nativeEvent: { actionName: removeName } }));
  expect(trusting).toHaveBeenCalledWith("zeta.example", false);
  act(() => barButton(root, "Edit")!.props.onPress());
  expect(removeButtons(root).length).toBeGreaterThan(0);
  act(() => removeButtons(root)[0]!.props.onPress());
  expect(trusting).toHaveBeenLastCalledWith("alpha.example", false);
  act(() => barButton(root, "Done")!.props.onPress());
  expect(removeButtons(root)).toHaveLength(0);
  unmount(root);
});

test("with no trusted sites there is no Edit button", () => {
  useBlocking.setState({ busy: false, state: { exemptHosts: [], lists: [] } as never });
  const root = renderSurface(<TrustedSitesPage />);
  expect(barButton(root, "Edit")).toBeUndefined();
  expect(textOf(root)).toContain("No Trusted Sites");
  unmount(root);
});
