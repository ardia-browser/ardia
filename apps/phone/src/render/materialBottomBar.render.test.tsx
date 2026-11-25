import { createRef } from "react";
import { Platform, StyleSheet, type TextInputInstance } from "react-native";
import { act } from "react-test-renderer";
import { MaterialBottomBar } from "../components/ui/MaterialBottomBar";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { renderSurface, someTabs, unmount, updateSurface, withMaterialYou } from "../../test/render/harness";

withMaterialYou();

const onAndroid = Platform.OS === "android" ? test : test.skip;

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

onAndroid("switching the overview boolean retains the capsule and replaces address actions with editable tab search", () => {
  const scheme = SEEDED_SCHEMES.ardia.light;
  const tabs = someTabs(2);
  const address = jest.fn();
  const search = { input: createRef<TextInputInstance>(), text: "work", focused: false, change: jest.fn(), focus: jest.fn(), blur: jest.fn() };
  const container = { testID: "sharedBar" };
  const page = <MaterialBottomBar isTabOverview={false} scheme={scheme} container={container} tab={tabs[0]!} order={tabs} showsPlus onAddress={address} onTabs={jest.fn()} onTabsMenu={jest.fn()} onStep={jest.fn()} onPlus={jest.fn()} onMore={jest.fn()} onSiteSettings={jest.fn()} />;
  const root = renderSurface(page);
  const hosts = (id: string) => root.root.findAll((node) => typeof node.type === "string" && node.props.testID === id);
  const action = (id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.props.onPress === "function")[0]!;
  const capsule = hosts("sharedBar")[0]!;
  const geometry = StyleSheet.flatten(capsule.props.style);
  act(() => action("materialAddressField").props.onPress());
  expect(address).toHaveBeenCalledTimes(1);

  updateSurface(root, <MaterialBottomBar isTabOverview scheme={scheme} container={container} search={search} incognito={false} canReopen={false} menusShown onMenu={jest.fn()} />);
  expect(hosts("sharedBar")).toHaveLength(1);
  expect(hosts("sharedBar")[0]).toBe(capsule);
  expect(StyleSheet.flatten(capsule.props.style)).toEqual(geometry);
  expect(hosts("materialAddressField")).toHaveLength(0);
  expect(hosts("materialBarTabs")).toHaveLength(0);
  expect(hosts("materialDeckIncognito")).toHaveLength(1);
  const field = hosts("deckSearchField")[0]!;
  expect(field.props.value).toBe("work");
  act(() => field.props.onChangeText("docs"));
  expect(search.change).toHaveBeenCalledWith("docs");
  expect(address).toHaveBeenCalledTimes(1);

  const startSearch = jest.fn();
  updateSurface(root, <MaterialBottomBar isStart scheme={scheme} container={container} incognito={false} onSearch={startSearch} />);
  expect(hosts("sharedBar")).toHaveLength(1);
  expect(hosts("sharedBar")[0]).toBe(capsule);
  expect(StyleSheet.flatten(capsule.props.style)).toEqual(geometry);
  expect(hosts("materialStartSearch")).toHaveLength(1);
  expect(hosts("deckSearchField")).toHaveLength(0);
  act(() => action("materialStartSearch").props.onPress());
  expect(startSearch).toHaveBeenCalledTimes(1);

  updateSurface(root, page);
  expect(hosts("sharedBar")[0]).toBe(capsule);
  expect(hosts("materialStartSearch")).toHaveLength(0);
  expect(hosts("deckSearchField")).toHaveLength(0);
  expect(hosts("materialDeckIncognito")).toHaveLength(0);
  expect(hosts("materialAddressField")).toHaveLength(1);
  unmount(root);
});
