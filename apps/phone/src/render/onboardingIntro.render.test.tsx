import type { ReactTestInstance } from "react-test-renderer";
import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { DEFAULT_BROWSER_ROUTE, OnboardingView, STEP_WORDS } from "../components/onboarding/OnboardingView";
import * as defaultBrowserState from "../state/settings/defaultBrowser";
import { useDefaultBrowser } from "../state/settings/defaultBrowser";
import { useOnboarding } from "../state/onboarding/store";
import { selectCopy } from "../lib/platformCopy";
import type { OnboardingStep } from "../state/settings/settingsRules";
import { useSync } from "../state/sync/store";
import { status } from "../../test/syncFixture";
import { pressButton, renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

jest.mock("../components/ui", () => ({ ...jest.requireActual<object>("../components/ui"), settingsUIAvailable: () => true }));

const onIos = Platform.OS === "ios" ? test : test.skip;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useSync.setState((state) => ({ ...state, status: status({ isEnabled: false, phase: "off" }) }));
  useDefaultBrowser.setState({ status: { isDefault: false, canAsk: false } });
  selectCopy(Platform.OS);
  jest.spyOn(defaultBrowserState, "refreshDefaultBrowser").mockImplementation(async () => null);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  act(() => useOnboarding.setState({ showing: false, step: "welcome", forward: true }));
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const hosts = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");

const showStep = (step: OnboardingStep) => {
  useOnboarding.setState({ showing: true, step, forward: true });
  const root = renderSurface(<OnboardingView />);
  for (const art of root.root.findAll((node) => typeof node.type === "string" && typeof node.props.onLayout === "function" && ["blockingDemo", "openLinkDemo", "syncFlight", "tipsReel"].includes(node.props.testID)))
    act(() => art.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 420 } } }));
  return root;
};

const liveStep = (root: Root) => hosts(root, "onboardingStep").at(-1)!;

const inside = (node: ReactTestInstance, testID: string) => node.findAll((child) => child.props.testID === testID && typeof child.type === "string");

onIos.each(["blocking", "defaultBrowser", "sync", "allSet"] as const)("in the iPhone intro the %s step leaves a slot for the one shared phone, drawn once under the steps", (step) => {
  const root = showStep(step);
  expect(hosts(root, "phoneStage")).toHaveLength(1);
  expect(hosts(root, "phoneFrame")).toHaveLength(1);
  expect(inside(liveStep(root), "phoneSlot")).toHaveLength(1);
  expect(inside(liveStep(root), "phoneFrame")).toHaveLength(0);
  expect(inside(hosts(root, "phoneStage")[0]!, "phoneFrame")).toHaveLength(1);
  unmount(root);
});

onIos("in the iPhone intro the welcome step has no phone slot", () => {
  const root = showStep("welcome");
  expect(inside(liveStep(root), "phoneSlot")).toHaveLength(0);
  unmount(root);
});

onIos("in the iPhone intro the all-set caption and dots stay with the step while its scenes play in the shared phone", () => {
  const root = showStep("allSet");
  expect(inside(liveStep(root), "tipsReelCaption")).toHaveLength(1);
  expect(inside(liveStep(root), "tipsReelDot")).toHaveLength(3);
  expect(inside(liveStep(root), "sceneFinger")).toHaveLength(0);
  unmount(root);
});

onIos("in the iPhone intro the default-browser step is a kit page: the phone, one title, the Settings route, Open Settings and Not Now, with no instruction card", async () => {
  const ask = jest.spyOn(defaultBrowserState, "askForDefaultBrowser").mockImplementation(async () => ({ status: null, unavailable: false }) as never);
  const root = showStep("defaultBrowser");
  const step = liveStep(root);
  const words = textOf({ root: step } as Root);
  expect(words).toContain(STEP_WORDS.defaultBrowser);
  expect(STEP_WORDS.defaultBrowser).toBe("Open links in Ardia");
  expect(words).toContain(DEFAULT_BROWSER_ROUTE);
  expect(words).toContain("Open Settings");
  expect(words).toContain("Not Now");
  expect(words).not.toContain("Maybe Later");
  expect(words).not.toContain("How to change your default browser");
  expect(inside(step, "defaultBrowserSheet")).toHaveLength(0);
  expect(inside(step, "linkBubbleIcon")).toHaveLength(0);
  await pressButton(root, "Open Settings");
  expect(ask).toHaveBeenCalledWith("openDefaultApps");
  expect(useOnboarding.getState().step).toBe("sync");
  unmount(root);
});

onIos("in the iPhone intro Not Now on the default-browser step moves on without asking", async () => {
  const ask = jest.spyOn(defaultBrowserState, "askForDefaultBrowser");
  const root = showStep("defaultBrowser");
  await pressButton(root, "Not Now");
  expect(ask).not.toHaveBeenCalled();
  expect(useOnboarding.getState().step).toBe("sync");
  unmount(root);
});
