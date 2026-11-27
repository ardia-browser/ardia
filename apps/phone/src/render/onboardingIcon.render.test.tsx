import { Platform, StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { LinkBubble } from "../components/onboarding/LinkBubble";
import { OnboardingView } from "../components/onboarding/OnboardingView";
import { AppIcon, rolesFor } from "../components/ui";
import { showOnboarding } from "../state/onboarding/store";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;
const onAndroid = Platform.OS === "android" ? test : test.skip;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

type Root = ReturnType<typeof renderSurface>;

const textOfNode = (node: Root["root"]) => textOf({ root: node } as Root);

const hostWithTestId = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string")[0]!;

onIos("on iPhone the welcome step shows the start screen's 128-point app icon with its shadow, fixed at any text size, with no white frame, and it scales in upright without a tilt", () => {
  showOnboarding();
  const root = renderSurface(<OnboardingView />);
  const slot = hostWithTestId(root, "welcomeIcon");
  const style = StyleSheet.flatten(slot.props.style);
  expect(style.padding).toBeUndefined();
  expect(style.backgroundColor).toBeUndefined();
  expect(style.boxShadow).toBeUndefined();
  const icon = slot.findAll((node) => node.type === AppIcon)[0]!;
  expect(icon.props).toMatchObject({ side: 128, shadow: true, scalesWithText: false });
  expect(StyleSheet.flatten(hostWithTestId(root, "appIcon").props.style).width).toBe(128);
  expect(style.opacity).toBe(0);
  expect(style.transform).toEqual([{ rotate: "0deg" }, { scale: 0.7 }]);
  unmount(root);
});

onAndroid("on Android the welcome step shows the 104-point app icon, fixed at any text size, in a frame of the icon's own cream 5 points wide with the frame's corner and the native apps' shadow", () => {
  showOnboarding();
  const root = renderSurface(<OnboardingView />);
  const frame = hostWithTestId(root, "welcomeIcon");
  const framed = StyleSheet.flatten(frame.props.style);
  expect(framed.padding).toBe(5);
  expect(framed.backgroundColor).toBe("#F8F3E1");
  expect(framed.borderRadius).toBeCloseTo(104 * 0.225 + 5);
  expect(framed.boxShadow).toBe("0px 12px 48px rgba(0, 0, 0, 0.18)");
  const icon = frame.findAll((node) => node.type === AppIcon)[0]!;
  expect(icon.props.side).toBe(104);
  expect(icon.props.scalesWithText).toBe(false);
  expect(StyleSheet.flatten(hostWithTestId(root, "appIcon").props.style).width).toBe(104);
  expect(frame.findAll((node) => node.props.source !== undefined && typeof node.type === "string").length).toBeGreaterThan(0);
  expect(framed.opacity).toBe(0);
  expect(framed.transform).toEqual([{ rotate: "-18deg" }, { scale: 0.7 }]);
  unmount(root);
});

test("the default browser step's art ends at the 60-point app icon with its shadow, not a drawn logo", () => {
  const root = renderSurface(<LinkBubble />);
  const icon = hostWithTestId(root, "linkBubbleIcon").findAll((node) => node.type === AppIcon)[0]!;
  expect(icon.props).toMatchObject({ side: 60, shadow: true, scalesWithText: false });
  const drawn = StyleSheet.flatten(hostWithTestId(root, "appIcon").props.style);
  expect(drawn.width).toBe(60);
  expect(drawn.boxShadow).toBe("0px 4px 20px rgba(0,0,0,0.12)");
  unmount(root);
});

const getStarted = (root: Root) => root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "button" && textOfNode(node) === "Get Started")[0]!;

onIos("on iPhone the welcome step's Get Started is a capsule at SwiftUI's 63⅓-point height, black with white text in light and white with black text in dark", () => {
  for (const dark of [false, true]) {
    const scheme = jest.spyOn(require("react-native"), "useColorScheme").mockReturnValue(dark ? "dark" : "light");
    showOnboarding();
    const root = renderSurface(<OnboardingView />);
    const button = getStarted(root);
    const style = StyleSheet.flatten(button.props.style);
    expect(style.minHeight).toBeCloseTo(190 / 3);
    expect(style.borderRadius).toBeCloseTo(190 / 6);
    expect(style.backgroundColor).toBe(rolesFor(dark).label);
    const label = button.findAll((node) => typeof node.type === "string" && node.type === "Text")[0]!;
    expect(StyleSheet.flatten(label.props.style).color).toBe(rolesFor(dark).pageSurface);
    unmount(root);
    scheme.mockRestore();
  }
});

onAndroid("on Android the welcome step's Get Started is the primary action: 16-point smooth corners in the space's accent with white text in light, not a navy capsule, at Compose's 50-point height", () => {
  showOnboarding();
  const root = renderSurface(<OnboardingView />);
  const button = getStarted(root);
  const style = StyleSheet.flatten(button.props.style);
  expect(style.borderRadius).toBe(16);
  expect(style.backgroundColor).toBe("#B25B6B");
  expect(style.minHeight).toBeCloseTo(50);
  const label = button.findAll((node) => typeof node.type === "string" && node.type === "Text")[0]!;
  expect(StyleSheet.flatten(label.props.style).color).toBe("#FFFFFF");
  unmount(root);
});
