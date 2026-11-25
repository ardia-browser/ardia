import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { SettingsView } from "../components/settings/SettingsView";
import { pages } from "../platform/pages";
import { openSettings } from "../state/settings/nav";
import { useSitePermissions } from "../state/settings/sitePermissions";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

const onAndroid = Platform.OS === "android" ? test : test.skip;

const GRANT = { origin: "https://meet.example", host: "meet.example", permissions: ["microphone", "camera"] as ("camera" | "microphone" | "location")[], grantedAt: 1 };

let revoked: [string, string | undefined][] = [];
let lists = true;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  revoked = [];
  lists = true;
  useSitePermissions.setState({ listed: false, grants: [] });
  jest.spyOn(pages, "listsSitePermissions").mockImplementation(() => lists);
  jest.spyOn(pages, "sitePermissions").mockImplementation(async () => (revoked.some(([, permission]) => permission === undefined) ? [] : [GRANT]));
  jest.spyOn(pages, "revokeSitePermission").mockImplementation(async (origin: string, permission?: string) => {
    revoked.push([origin, permission]);
    return true;
  });
  jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const pressable = (root: Root, label: string) => root.root.findAll((node) => (node.props.accessibilityLabel === label || node.props.children === label) && typeof node.props.onPress === "function")[0];
const button = (root: Root, title: string) => root.root.findAll((node) => typeof node.props.onPress === "function" && node.findAll((inner) => inner.props.children === title).length > 0).at(-1);

const settle = async () => {
  await act(async () => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  });
};

onAndroid("Android's Site Settings lists the sites kept with camera, microphone or location, and a site's dialog revokes one kind or all of them", async () => {
  openSettings({ page: "siteSettings" });
  const root = renderSurface(<SettingsView />);
  await settle();
  expect(textOf(root)).toContain("Camera, Microphone and Location");
  const row = pressable(root, "meet.example, Camera and Microphone") ?? root.root.findAll((node) => node.props.testID === "allowedSite" && typeof node.props.onPress === "function")[0]!;
  expect(row).toBeDefined();
  act(() => row!.props.onPress());
  expect(textOf(root)).toContain("Revoke Camera");
  expect(textOf(root)).toContain("Revoke Microphone");
  act(() => button(root, "Revoke Camera")!.props.onPress());
  await settle();
  expect(revoked).toEqual([["https://meet.example", "camera"]]);
  act(() => root.root.findAll((node) => node.props.testID === "allowedSite" && typeof node.props.onPress === "function")[0]!.props.onPress());
  act(() => button(root, "Revoke All")!.props.onPress());
  await settle();
  expect(revoked.at(-1)).toEqual(["https://meet.example", undefined]);
  expect(textOf(root)).toContain("None");
  unmount(root);
});

onAndroid("where the page engine can't list kept permissions, Site Settings shows no such section", async () => {
  lists = false;
  openSettings({ page: "siteSettings" });
  const root = renderSurface(<SettingsView />);
  await settle();
  expect(textOf(root)).not.toContain("Camera, Microphone and Location");
  unmount(root);
});
