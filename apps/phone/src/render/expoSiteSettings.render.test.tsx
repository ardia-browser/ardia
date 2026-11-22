import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { SettingsView } from "../components/settings/SettingsView";
import { pages } from "../platform/pages";
import { openSettings, openSettingsPage, settingsNav } from "../state/settings/nav";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;

const GRANT = { origin: "https://meet.example", host: "meet.example", permissions: ["microphone", "camera"] as ("camera" | "microphone" | "location")[], grantedAt: 1 };

let revoked: [string, string | undefined][] = [];

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  revoked = [];
  jest.spyOn(pages, "listsSitePermissions").mockReturnValue(true);
  jest.spyOn(pages, "sitePermissions").mockImplementation(async () => (revoked.some(([, permission]) => permission === undefined) ? [] : [GRANT]));
  jest.spyOn(pages, "revokeSitePermission").mockImplementation(async (origin: string, permission?: string) => {
    revoked.push([origin, permission]);
    return true;
  });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const hosts = (root: Root, has: (props: Record<string, unknown>) => boolean) => root.root.findAll((node) => typeof node.type === "string" && has(node.props));
const titlesIn = (node: ReactTestInstance) => node.findAll((inner) => typeof inner.type === "string" && typeof inner.props.title === "string" && typeof inner.props.systemImage === "string").map((inner) => inner.props.title as string);
const page = (root: Root) => hosts(root, (props) => props.name === "destination" && (props.extraProps as { value?: string } | undefined)?.value === "siteSettings")[0]!;
const within = (node: ReactTestInstance, has: (props: Record<string, unknown>) => boolean) => node.findAll((inner) => typeof inner.type === "string" && has(inner.props));
const press = async (node: ReactTestInstance) => act(async () => void (node.props.onButtonPress ?? node.props.onPress)({ nativeEvent: {} }));

onIos("on iPhone Site Settings is main's page on Expo UI: its rows in main's order, the change-one-site footer, and the sites allowed the camera, microphone or location with what each may use", async () => {
  openSettings({ page: "siteSettings" });
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  expect(titlesIn(page(root))).toEqual(["Block Ads", "Block Trackers", "Block Cookie Banners", "Filter Lists", "Trusted Sites", "Night Shade", "Swipe to Navigate", "Collapse Bottom Bar"]);
  expect(within(page(root), (props) => typeof props.text === "string").map((node) => node.props.text)).toEqual(expect.arrayContaining(["Change one site from its page menu.", "meet.example", "Camera and Microphone", "Sites you allowed keep access on this iPhone until you revoke it. Private tabs always ask.", "Allowed: Camera and Microphone"]));
  expect(hosts(root, (props) => props.title === "Camera, Microphone and Location")).toHaveLength(1);
  unmount(root);
});

onIos("a site's swipe Revoke takes all its access, counts once, and leaves the list saying None; the dialog can revoke one permission alone", async () => {
  const counts = jest.spyOn(telemetry, "countUsage");
  openSettings({ page: "siteSettings" });
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const revokeOne = within(page(root), (props) => props.label === "Revoke Microphone")[0]!;
  await press(revokeOne);
  expect(revoked).toEqual([["https://meet.example", "microphone"]]);
  revoked = [];
  const swipe = within(page(root), (props) => props.label === "Revoke" && props.role === "destructive")[0]!;
  await press(swipe);
  expect(revoked).toEqual([["https://meet.example", undefined]]);
  expect(counts.mock.calls.filter(([field]) => field === "site_permissions_revoked")).toHaveLength(2);
  expect(within(page(root), (props) => typeof props.text === "string").map((node) => node.props.text)).toContain("None");
  unmount(root);
});

onIos("Site Settings from the page menu is the Settings sheet's first page, with Settings' Done, and Done closes it", async () => {
  openSettingsPage({ page: "siteSettings" });
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const stack = hosts(root, (props) => Array.isArray(props.path))[0]!;
  expect(stack.props.path).toEqual([]);
  expect(titlesIn(stack)).toContain("Block Ads");
  expect(titlesIn(stack)).not.toContain("Search Engine");
  const done = within(stack, (props) => typeof (props.onButtonPress ?? props.onPress) === "function").find((node) => node.props.label === "Done" || node.findAll((inner) => inner.props.text === "Done").length > 0)!;
  await press(done);
  expect(settingsNav().open).toBe(false);
  unmount(root);
});
