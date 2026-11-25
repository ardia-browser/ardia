import { Platform, StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { OnboardingView } from "../components/onboarding/OnboardingView";
import { DesignProvider } from "../components/ui";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { setDynamicScheme } from "../state/app/dynamicScheme";
import { useOnboarding } from "../state/onboarding/store";
import { classicOnAndroid, renderSurface, unmount, withTabs, withMaterialYou } from "../../test/render/harness";

withMaterialYou();

const onAndroid = Platform.OS === "android" ? test : test.skip;
const LIGHT = SEEDED_SCHEMES.ardia.light;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(0);
  setDynamicScheme(null);
});

afterEach(() => {
  act(() => useOnboarding.setState({ showing: false, step: "welcome", forward: true }));
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

type Root = ReturnType<typeof renderSurface>;
const node = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.type === "string")[0];
const flat = (found: ReactTestInstance | undefined) => StyleSheet.flatten(found?.props.style) ?? {};

const onboarding = (step: "welcome" | "sync") => {
  act(() => useOnboarding.setState({ showing: true, step, forward: true }));
  return renderSurface(
    <DesignProvider design="material">
      <OnboardingView />
    </DesignProvider>,
  );
};

onAndroid("the material welcome's Get Started is a 56 dp filled button in primary with a ripple, under a displaySmall title", () => {
  const root = onboarding("welcome");
  const primary = node(root, "materialOnboardingPrimary")!;
  expect(flat(primary)).toMatchObject({ minHeight: 56, borderRadius: 9999, backgroundColor: LIGHT.primary });
  expect(root.root.findAll((found) => found.props.testID === "materialOnboardingPrimary" && typeof found.props.onPress === "function")[0]!.props.android_ripple).toMatchObject({ borderless: false });
  const title = root.root.findAll((found) => typeof found.type === "string" && found.props.accessibilityRole === "header")[0]!;
  expect(flat(title).fontSize).toBe(36);
  unmount(root);
});

onAndroid("a material step's second choice is a text button in primary", () => {
  const root = onboarding("sync");
  expect(node(root, "materialOnboardingPrimary")).toBeDefined();
  const secondary = node(root, "materialOnboardingSecondary")!;
  expect(flat(secondary).minHeight).toBe(48);
  expect(flat(secondary.findAll((found) => typeof found.type === "string" && typeof found.props.children === "string")[0]).color).toBe(LIGHT.primary);
  unmount(root);
});

onAndroid("the original design's onboarding keeps its own buttons", () => {
  act(() => useOnboarding.setState({ showing: true, step: "welcome", forward: true }));
  const root = renderSurface(classicOnAndroid(<OnboardingView />));
  expect(node(root, "materialOnboardingPrimary")).toBeUndefined();
  unmount(root);
});
