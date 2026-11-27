import { Platform, StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { OnboardingView, SYNC_SUBTITLE } from "../components/onboarding/OnboardingView";
import { SyncScanIllustration } from "../components/onboarding/SyncScanIllustration";
import { SyncFlight } from "../components/onboarding/StepPhones";
import { Symbol } from "../components/ui";
import { SKETCH_QR_ROWS, sketchQrPath } from "../lib/sketchQr";
import { useOnboarding } from "../state/onboarding/store";
import { useSync } from "../state/sync/store";
import { closeSettings, settingsNav } from "../state/settings/nav";

const onIos = Platform.OS === "ios" ? test : test.skip;
const onAndroid = Platform.OS === "android" ? test : test.skip;
import { status } from "../../test/syncFixture";
import { pressButton, renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useSync.setState((state) => ({ ...state, status: status({ isEnabled: false, phase: "off" }) }));
  useOnboarding.setState({ showing: true, step: "sync", forward: true });
});

afterEach(() => {
  act(() => closeSettings());
  act(() => jest.runOnlyPendingTimers());
  useOnboarding.setState({ showing: false, step: "welcome", forward: true });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const host = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");

onIos("on iPhone the sync step draws the flight of tabs from the Mac to the phone instead of the scanning sketch, not a symbol", () => {
  const root = renderSurface(<OnboardingView />);
  expect(root.root.findAll((node) => node.type === SyncFlight)).toHaveLength(1);
  expect(root.root.findAll((node) => node.type === SyncScanIllustration)).toHaveLength(0);
  expect(host(root, "syncFlight")).toHaveLength(1);
  expect(host(root, "syncFlightCheck")).toHaveLength(0);
  expect(root.root.findAll((node) => node.type === Symbol && (node.props.name === "macAndPhone" || node.props.name === "checkmarkCircle"))).toHaveLength(0);
  unmount(root);
});

onAndroid("on Android the sync step draws the native apps' Mac window with its QR code and the phone scanning it, not a symbol", () => {
  const root = renderSurface(<OnboardingView />);
  expect(root.root.findAll((node) => node.type === SyncScanIllustration)).toHaveLength(1);
  expect(root.root.findAll((node) => node.type === Symbol && (node.props.name === "macAndPhone" || node.props.name === "checkmarkCircle"))).toHaveLength(0);
  const mac = StyleSheet.flatten(host(root, "syncSketchMac")[0]!.props.style);
  expect(mac).toMatchObject({ width: 250, height: 168, marginRight: 46, marginBottom: 40, borderRadius: 12 });
  const phone = StyleSheet.flatten(host(root, "syncSketchPhone")[0]!.props.style);
  expect(phone).toMatchObject({ width: 92, height: 186, borderRadius: 22, backgroundColor: "#141414" });
  expect(StyleSheet.flatten(host(root, "syncSketchScreen")[0]!.props.style).backgroundColor).toBe("#383838");
  expect(root.root.findAll((node) => node.props.testID === "syncSketchQr" && typeof node.type === "string").map((node) => node.props.width)).toEqual([74, 40]);
  expect(host(root, "syncSketchFinder")).toHaveLength(1);
  expect(host(root, "syncSketchCheck")).toHaveLength(0);
  unmount(root);
});

test("the sketch's QR code is a real 25-module code with its three finder squares", () => {
  expect(SKETCH_QR_ROWS).toHaveLength(25);
  expect(SKETCH_QR_ROWS.every((row) => row.length === 25)).toBe(true);
  for (const [top, left] of [
    [0, 0],
    [0, 18],
    [18, 0],
  ]) {
    expect(SKETCH_QR_ROWS[top!]!.slice(left, left! + 7)).toBe("1111111");
    expect(SKETCH_QR_ROWS[top! + 1]!.slice(left, left! + 7)).toBe("1000001");
    expect(SKETCH_QR_ROWS[top! + 2]!.slice(left, left! + 7)).toBe("1011101");
  }
  expect(sketchQrPath(["10", "01"])).toBe("M0 0h1v1h-1zM1 1h1v1h-1z");
});

test("once connected, the subtitle crossfades to say the Mac's tabs are here, and the art shows its checkmark: the flight's badge on iPhone, the viewfinder scaling out as the checkmark scales in on a plum screen on Android", () => {
  const root = renderSurface(<OnboardingView />);
  const before = root.root.findAll((node) => node.props.testID === "onboardingSubtitle" && typeof node.type === "string");
  expect(before).toHaveLength(1);
  act(() => useSync.setState((state) => ({ ...state, status: status({ isEnabled: true, phase: "updated" }) })));
  const subtitle = root.root.findAll((node) => node.props.testID === "onboardingSubtitle" && typeof node.type === "string" && textOf({ root: node } as never) === SYNC_SUBTITLE.connected);
  expect(subtitle).toHaveLength(1);
  const fading = root.root.findAll((node) => node.props.testID === "onboardingSubtitle" && node.props.entering !== undefined)[0]!;
  expect(fading.props.exiting).toBeDefined();
  if (Platform.OS === "ios") {
    expect(host(root, "syncFlightCheck")).toHaveLength(1);
    expect(host(root, "syncSketchCheck")).toHaveLength(0);
    unmount(root);
    return;
  }
  const check = root.root.findAll((node) => node.props.testID === "syncSketchCheck" && node.props.entering !== undefined)[0]!;
  expect(typeof check.props.entering).toBe("function");
  expect(typeof check.props.exiting).toBe("function");
  expect(check.findAll((node) => node.type === Symbol)[0]!.props.name).toBe("checkmark");
  const screen = StyleSheet.flatten(host(root, "syncSketchScreen")[0]!.props.style);
  expect(screen.backgroundColor).toBeUndefined();
  expect(String(screen.experimental_backgroundImage)).toContain("linear-gradient");
  unmount(root);
});

onIos("on iPhone Connect to Your Mac opens the very Settings connect page, as the stack's root with Cancel, and closing it lands back on this onboarding step", async () => {
  const root = renderSurface(<OnboardingView />);
  await pressButton(root, "Connect to Your Mac");
  expect(root.root.findAll((node) => node.props.testID === "onboardingConnect")).toHaveLength(0);
  expect(settingsNav()).toMatchObject({ open: true, stack: [{ page: "syncConnect" }] });
  act(() => closeSettings());
  expect(useOnboarding.getState()).toMatchObject({ showing: true, step: "sync" });
  unmount(root);
});

onAndroid("Connect to Your Mac slides the connect screen up from the bottom of the window, as Compose does, instead of popping it in, with Cancel to leave it", async () => {
  const root = renderSurface(<OnboardingView />);
  expect(root.root.findAll((node) => node.props.testID === "onboardingConnect")).toHaveLength(0);
  await pressButton(root, "Connect to Your Mac");
  const sheet = root.root.findAll((node) => node.props.testID === "onboardingConnect" && node.props.entering !== undefined)[0]!;
  const entering = (sheet.props.entering as () => { initialValues: { opacity: number; transform: { translateY: number }[] } })();
  expect(entering.initialValues.opacity).toBe(0);
  expect(entering.initialValues.transform[0]!.translateY).toBeGreaterThan(0);
  expect(typeof sheet.props.exiting).toBe("function");
  expect(sheet.findAll((node) => typeof node.type === "string" && node.props.accessibilityViewIsModal === true)).not.toHaveLength(0);
  expect(textOf({ root: sheet } as never)).toContain("Cancel");
  expect(textOf({ root: sheet } as never)).not.toContain("Close");
  unmount(root);
});
