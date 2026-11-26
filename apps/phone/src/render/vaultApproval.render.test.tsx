import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { VaultApprovalSheet } from "../components/vault/VaultApprovalSheet";
import { sync } from "../platform/sync";
import { EMPTY_VIEW, useSync } from "../state/sync/store";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, unmount } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;

const NOW = Date.UTC(2026, 10, 22, 12);
const request = { id: "0f0e0d0c-0b0a-4908-8706-050403020100", program: "node, unsigned", sites: ["https://github.com", "https://accounts.example"], why: "deploy the docs", profileName: "Personal", alwaysOffered: true, trusted: true, askedAt: NOW - 2_000, expiresAt: NOW + 90_000, fromDeviceId: "mac", fromDevice: "MacBook Pro" };

const within = (node: ReactTestInstance, has: (props: Record<string, unknown>) => boolean) => node.findAll((inner) => typeof inner.type === "string" && has(inner.props));
const texts = (node: ReactTestInstance) => within(node, (props) => typeof props.text === "string" || typeof props.title === "string" || typeof props.label === "string").map((inner) => (inner.props.text ?? inner.props.title ?? inner.props.label) as string);
const button = (node: ReactTestInstance, label: string) => within(node, (props) => typeof props.onButtonPress === "function" || typeof props.onPress === "function").find((inner) => texts(inner).includes(label))!;
const press = async (node: ReactTestInstance) => act(async () => void (node.props.onButtonPress ?? node.props.onPress)({ nativeEvent: {} }));
const presented = (root: ReturnType<typeof renderSurface>) => within(root.root, (props) => typeof props.isPresented === "boolean")[0]!.props.isPresented as boolean;

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  useSync.setState({ view: { ...EMPTY_VIEW, vaultRequests: [request] } });
});

afterEach(() => {
  useSync.setState({ view: EMPTY_VIEW });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

onIos("a sign-in request from the Mac opens a sheet naming the program as the Mac gives it, its sites, its reason and who asked, and counts the showing", () => {
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  const root = renderSurface(<VaultApprovalSheet />);
  expect(presented(root)).toBe(true);
  expect(texts(root.root)).toEqual(expect.arrayContaining(["node, unsigned", "Asks to sign in from MacBook Pro · Personal", "github.com", "accounts.example", "deploy the docs", "Allow with Face ID", "Don’t Allow", "Always Allow node, unsigned on These Sites"]));
  expect(counted.mock.calls).toEqual([["vault_requests_shown"]]);
  unmount(root);
});

onIos("Allow with Always on goes to the native side, which asks for Face ID before it answers, and the sheet closes once the answer is sent", async () => {
  jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  const answer = jest.spyOn(sync, "answerVaultRequest").mockResolvedValue("sent");
  const root = renderSurface(<VaultApprovalSheet />);
  const toggle = within(root.root, (props) => typeof props.onIsOnChange === "function")[0]!;
  await act(async () => void toggle.props.onIsOnChange({ nativeEvent: { isOn: true } }));
  await press(button(root.root, "Allow with Face ID"));
  expect(answer).toHaveBeenCalledWith(request.id, true, true);
  expect(presented(root)).toBe(false);
  unmount(root);
});

onIos("a cancelled Face ID keeps the sheet open and is counted; Don't Allow never carries Always", async () => {
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  const answer = jest.spyOn(sync, "answerVaultRequest").mockResolvedValueOnce("cancelled").mockResolvedValueOnce("sent");
  const root = renderSurface(<VaultApprovalSheet />);
  await press(button(root.root, "Allow with Face ID"));
  expect(presented(root)).toBe(true);
  expect(counted).toHaveBeenCalledWith("vault_face_id_cancelled");
  await press(button(root.root, "Don’t Allow"));
  expect(answer).toHaveBeenLastCalledWith(request.id, false, false);
  expect(counted).toHaveBeenCalledWith("vault_requests_denied");
  expect(presented(root)).toBe(false);
  unmount(root);
});

onIos("the sheet closes by itself when the request expires or the Mac answers first", () => {
  jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  const root = renderSurface(<VaultApprovalSheet />);
  expect(presented(root)).toBe(true);
  act(() => jest.advanceTimersByTime(91_000));
  expect(presented(root)).toBe(false);
  act(() => useSync.setState({ view: { ...EMPTY_VIEW, vaultRequests: [{ ...request, id: "11111111-1111-4111-8111-111111111111", expiresAt: Date.now() + 60_000 }] } }));
  expect(presented(root)).toBe(true);
  act(() => useSync.setState({ view: { ...EMPTY_VIEW, vaultRequests: [] } }));
  expect(presented(root)).toBe(false);
  unmount(root);
});

onIos("a program the Mac won't let you always allow (the ardia command, an interpreter, an unsigned one) gets no Always Allow, and Allow never asks for it", async () => {
  jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  const answer = jest.spyOn(sync, "answerVaultRequest").mockResolvedValue("sent");
  useSync.setState({ view: { ...EMPTY_VIEW, vaultRequests: [{ ...request, alwaysOffered: false }] } });
  const root = renderSurface(<VaultApprovalSheet />);
  expect(within(root.root, (props) => typeof props.onIsOnChange === "function")).toEqual([]);
  expect(texts(root.root).some((text) => text.startsWith("Always Allow"))).toBe(false);
  expect(texts(root.root).some((text) => text.startsWith("Ends in"))).toBe(true);
  await press(button(root.root, "Allow with Face ID"));
  expect(answer).toHaveBeenCalledWith(request.id, true, false);
  unmount(root);
});

onIos("before the Mac trusts this iPhone, the sheet shows its key's code and how to trust it there, offers no Allow but still lets you say no, and makes the key if there is none", async () => {
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  const prepare = jest.spyOn(sync, "prepareVaultKey").mockResolvedValue("4979 42AC F8F3 4E6A 2DBB");
  useSync.setState({ view: { ...EMPTY_VIEW, vaultRequests: [{ ...request, trusted: false }], vaultKey: null } });
  const root = renderSurface(<VaultApprovalSheet />);
  await act(async () => undefined);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(texts(root.root)).toEqual(expect.arrayContaining(["Trust This iPhone First", "Don’t Allow"]));
  expect(texts(root.root)).not.toContain("Allow with Face ID");
  expect(within(root.root, (props) => typeof props.onIsOnChange === "function")).toEqual([]);
  act(() => useSync.setState({ view: { ...EMPTY_VIEW, vaultRequests: [{ ...request, trusted: false }], vaultKey: "4979 42AC F8F3 4E6A 2DBB" } }));
  expect(texts(root.root)).toContain("4979 42AC F8F3 4E6A 2DBB");
  expect(counted).toHaveBeenCalledWith("vault_requests_untrusted");
  const answer = jest.spyOn(sync, "answerVaultRequest").mockResolvedValue("sent");
  await press(button(root.root, "Don’t Allow"));
  expect(answer).toHaveBeenCalledWith(request.id, false, false);
  expect(presented(root)).toBe(false);
  unmount(root);
});
