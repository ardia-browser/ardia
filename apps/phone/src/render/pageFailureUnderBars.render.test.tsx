import { Platform, StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { DesignProvider } from "../components/ui";
import { useBrowse } from "../state/browse/store";
import { usePages, storeNavigation, type PageState } from "../state/pages/store";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

jest.mock("@ardia/phone-native", () => ({ ...jest.requireActual("@ardia/phone-native"), pageObscuresInsets: () => true }));

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  usePages.setState({ navigation: {}, tones: {}, lastTones: {}, heldTones: {} });
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

type Root = ReturnType<typeof renderSurface>;
const node = (root: Root, testID: string) => root.root.findAll((found) => found.props.testID === testID && typeof found.type === "string")[0];
const style = (found: ReactTestInstance) => ({ ...StyleSheet.flatten(found.props.style), ...getAnimatedStyle(found) }) as Record<string, unknown>;
const failed = (failure: PageState["failure"]) => ({ url: "https://i.example/", title: "", isLive: true, isLoading: false, progress: 1, failure, canGoBack: false, canGoForward: false }) as unknown as PageState;
const unreachable = { kind: "network", reason: "timedOut", title: "This Webpage Couldn’t Load", message: "Something went wrong while loading this page. Try again." } as unknown as PageState["failure"];

test("with the page under the bars, a failed page fills with the page colour the status strip uses, so the screen is one surface under the glass bar", () => {
  const tab = currentTabs().open[0]!;
  storeNavigation(tab.id, failed(unreachable));
  const design = Platform.OS === "ios" ? "redesigned" : "material";
  const root = renderSurface(
    <DesignProvider design={design}>
      <BrowsingScreen tab={tab} />
    </DesignProvider>,
    { flushTimers: false },
  );
  const fill = String(style(node(root, "pageFailure")!).backgroundColor);
  expect(String(style(node(root, "pageStatusStrip")!).backgroundColor)).toBe(fill);
  unmount(root);
});
