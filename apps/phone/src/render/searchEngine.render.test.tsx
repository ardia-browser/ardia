import { act } from "react-test-renderer";
import { SearchEnginePage } from "../components/settings/SitePages";
import { useEngines } from "../state/settings/actions";
import { useSync } from "../state/sync/store";
import { status } from "../../test/syncFixture";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useEngines.setState({ engines: [{ id: "google", name: "Google" }, { id: "duckduckgo", name: "DuckDuckGo" }] });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

test("with sync on, Search Engine shows the Mac's engine beside a laptop, custom engines by their own name", () => {
  useSync.setState((state) => ({
    ...state,
    status: status({ isEnabled: true, phase: "updated" }),
    view: { ...state.view, search: { engineId: "mac-wiki", customURL: null, customEngines: [{ id: "mac-wiki", name: "Wiki", keyword: "w", url: "https://wiki.example/?q=%s" }] } } as never,
  }));
  const root = renderSurface(<SearchEnginePage />);
  const row = root.root.findAll((node) => node.props.testID === "engineFromMac" && typeof node.type === "string")[0]!;
  expect(row.props.accessibilityValue).toEqual({ text: "Wiki" });
  expect(row.findAll((node) => node.props.name === "laptop").length).toBeGreaterThan(0);
  unmount(root);
});

test("with sync off, the picker lists the built-in engines it was given and nothing else", () => {
  useSync.setState((state) => ({ ...state, status: status({ isEnabled: false, phase: "off" }) }));
  const root = renderSurface(<SearchEnginePage />);
  const radios = root.root.findAll((node) => node.props.accessibilityRole === "radio" && typeof node.props.onPress === "function");
  expect(radios.map((radio) => textOf({ root: radio } as never))).toEqual(["Google", "DuckDuckGo"]);
  expect(textOf(root)).not.toContain("Custom");
  unmount(root);
});
