import { StyleSheet } from "react-native";
import * as Reanimated from "react-native-reanimated";
import { act } from "react-test-renderer";
import { flightEnds, flightScale, flightTimes, PHONE_IN_STAGE, stageAround } from "../components/onboarding/SyncScene";
import { SyncFlight } from "../components/onboarding/StepPhones";
import { syncFlight } from "../components/onboarding/syncFlightTokens";
import { phoneFrame } from "../components/onboarding/onboardingTokens";
import { useSync } from "../state/sync/store";
import { status } from "../../test/syncFixture";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const mockMotion = { reduced: false };
jest.mock("../state/app/systemLook", () => ({ ...jest.requireActual("../state/app/systemLook"), useReduceMotion: () => mockMotion.reduced }));

const connect = (connected: boolean) => useSync.setState((state) => ({ ...state, status: status(connected ? { isEnabled: true, phase: "updated" } : { isEnabled: false, phase: "off" }) }));

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  mockMotion.reduced = false;
  connect(false);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const hosts = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");

const measure = (root: Root, width: number = syncFlight.stage.width, height: number = syncFlight.stage.height) =>
  act(() => hosts(root, "syncFlight")[0]!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height } } }));

test("the flight is decorative: hidden from VoiceOver and TalkBack", () => {
  const root = renderSurface(<SyncFlight />);
  const frame = hosts(root, "syncFlight")[0]!;
  expect(frame.props.accessibilityElementsHidden).toBe(true);
  expect(frame.props.importantForAccessibility).toBe("no-hide-descendants");
  expect(root.root.findAll((node) => typeof node.type === "string" && node.props.accessible === true)).toHaveLength(0);
  unmount(root);
});

test("while not connected, three tabs loop one at a time from the Mac sidebar into the phone's list, with no placeholder slots and no checkmark", () => {
  const repeat = jest.spyOn(Reanimated, "withRepeat");
  const root = renderSurface(<SyncFlight />);
  measure(root);
  expect(repeat).toHaveBeenCalledTimes(1);
  expect(hosts(root, "syncFlightMacRow")).toHaveLength(syncFlight.tabs.length);
  expect(hosts(root, "syncFlightChip")).toHaveLength(syncFlight.loop.flights.length);
  expect(hosts(root, "syncFlightPhoneRow")).toHaveLength(syncFlight.loop.flights.length);
  expect(hosts(root, "syncFlightCheck")).toHaveLength(0);
  expect(hosts(root, "phoneFrame")).toHaveLength(1);
  unmount(root);
});

test("once connected the loop stops, the phone shows every tab and the checkmark badge pops in", () => {
  connect(true);
  const repeat = jest.spyOn(Reanimated, "withRepeat");
  const root = renderSurface(<SyncFlight />);
  measure(root);
  expect(repeat).not.toHaveBeenCalled();
  expect(hosts(root, "syncFlightCheck")).toHaveLength(1);
  expect(hosts(root, "syncFlightChip")).toHaveLength(0);
  expect(hosts(root, "syncFlightPhoneRow")).toHaveLength(syncFlight.tabs.length);
  unmount(root);
});

test("with Reduce Motion nothing flies or loops: the phone shows its filled list", () => {
  mockMotion.reduced = true;
  const repeat = jest.spyOn(Reanimated, "withRepeat");
  const root = renderSurface(<SyncFlight />);
  measure(root);
  expect(repeat).not.toHaveBeenCalled();
  expect(hosts(root, "syncFlightChip")).toHaveLength(0);
  expect(hosts(root, "syncFlightPhoneRow")).toHaveLength(syncFlight.loop.flights.length);
  expect(hosts(root, "syncFlightCheck")).toHaveLength(0);
  unmount(root);
});

test("the Mac's page is neutral lines, with no coloured hero block", () => {
  const root = renderSurface(<SyncFlight />);
  measure(root);
  const mac = hosts(root, "syncFlightMac")[0]!;
  const painted = mac.findAll((node) => typeof node.type === "string" && StyleSheet.flatten(node.props.style)?.experimental_backgroundImage !== undefined);
  expect(painted).toHaveLength(0);
  unmount(root);
});

test("the stage scales down to fit the space it gets and never grows past its drawn size", () => {
  const { width, height } = syncFlight.stage;
  expect(flightScale(width * 3, height * 3)).toBe(1);
  expect(flightScale(width / 2, height * 3)).toBeCloseTo(0.5);
  expect(flightScale(width * 3, height / 4)).toBeCloseTo(0.25);
  const root = renderSurface(<SyncFlight />);
  expect(StyleSheet.flatten(hosts(root, "syncFlight")[0]!.props.style).opacity).toBe(0);
  measure(root, width / 2, height * 2);
  expect(StyleSheet.flatten(hosts(root, "syncFlight")[0]!.props.style).opacity).toBe(1);
  expect(StyleSheet.flatten(hosts(root, "syncFlightStage")[0]!.props.style)).toMatchObject({ width: width / 2, height: height / 2 });
  unmount(root);
});

test("each flight is about 0.6 s, one tab at a time, and the list fades away only after the last tab lands, before the loop ends", () => {
  const loop = syncFlight.loop;
  expect(loop.flyMs).toBe(600);
  for (let flight = 0; flight < loop.flights.length; flight++) {
    const times = flightTimes(flight);
    expect(times.arrived - times.lifted).toBe(loop.flyMs);
    if (flight > 0) expect(times.start).toBeGreaterThanOrEqual(flightTimes(flight - 1).arrived);
  }
  const last = flightTimes(loop.flights.length - 1);
  expect(loop.resetFromMs).toBeGreaterThan(last.glowGone);
  expect(loop.resetFromMs + loop.resetMs).toBeLessThanOrEqual(loop.ms);
});

test("a flying tab starts as the Mac row and lands exactly as the phone row it becomes", () => {
  const { from, to } = flightEnds(1);
  expect(from).toMatchObject({ width: syncFlight.mac.sidebarWidth - 2 * syncFlight.macRow.inset, height: syncFlight.macRow.height, swatch: syncFlight.macRow.swatch });
  const scale = syncFlight.phone.scale;
  const list = syncFlight.phoneList;
  expect(to.height).toBeCloseTo(list.height * scale);
  expect(to.swatch).toBeCloseTo(list.swatch * scale);
  expect(to.radius).toBeCloseTo(list.radius * scale);
  expect(to.y).toBeCloseTo(syncFlight.phone.top + (phoneFrame.bezel + list.top + list.height + list.gap) * scale);
});

test("the shared stage puts the Mac where it sits beside the phone in the step's own layout", () => {
  const scale = 0.8;
  const phone = { x: 40 + PHONE_IN_STAGE.left * scale, y: 100 + PHONE_IN_STAGE.top * scale, width: PHONE_IN_STAGE.width * scale, height: PHONE_IN_STAGE.height * scale };
  const stage = stageAround(phone);
  expect(stage.x).toBeCloseTo(40);
  expect(stage.y).toBeCloseTo(100);
  expect(stage.scale).toBeCloseTo(scale);
});
