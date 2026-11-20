import { Platform } from "react-native";
import { act } from "react-test-renderer";

const core = require("expo-modules-core") as { requireOptionalNativeModule: (name: string) => unknown };
const realOptional = core.requireOptionalNativeModule;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

let offers: Deferred<"link" | "text" | null>[] = [];
let reads: Deferred<string | null>[] = [];
const native = {
  offer: jest.fn(() => {
    const next = deferred<"link" | "text" | null>();
    offers.push(next);
    return next.promise;
  }),
  read: jest.fn(() => {
    const next = deferred<string | null>();
    reads.push(next);
    return next.promise;
  }),
};
const readsNatively = Platform.OS === "ios";
const clipboardNative = readsNatively ? native : { offer: native.offer };
jest.spyOn(core, "requireOptionalNativeModule").mockImplementation((name: string) => (name === "ArdiaPhoneClipboard" ? clipboardNative : realOptional(name)));
const expoClipboard = require("expo-clipboard") as typeof import("expo-clipboard");
jest.spyOn(expoClipboard, "getStringAsync").mockImplementation(() => native.read().then((text) => text ?? ""));

const telemetry = require("../state/telemetry/telemetry") as typeof import("../state/telemetry/telemetry");
const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
const { activateRow } = require("../state/browse/store") as typeof import("../state/browse/store");
const { dismissSearch, presentSearch, useSearch } = require("../state/search/store") as typeof import("../state/search/store");
const { currentTabs, useTabs } = require("../state/tabs/store") as typeof import("../state/tabs/store");
const { withTabs } = require("../../test/render/harness") as typeof import("../../test/render/harness");

const settle = () => act(async () => undefined);
const pasteRow = () => useSearch.getState().rows.find((row) => row.kind === "paste");
const tabCount = () => currentTabs().open.length + currentTabs().privates.length;

async function answer<T>(asked: Deferred<T>[], value: T) {
  await settle();
  asked.at(-1)!.resolve(value);
  await settle();
}

async function trayOffering(offer: "link" | "text", incognito = false) {
  presentSearch("home", "", incognito);
  await answer(offers, offer);
  const row = pasteRow();
  if (!row) throw new Error("no paste row");
  return row;
}

beforeEach(() => {
  offers = [];
  reads = [];
  native.offer.mockClear();
  native.read.mockClear();
  counted.mockClear();
  withTabs(2);
});

afterEach(() => act(() => dismissSearch()));

test("a second tap while the first paste is still being read neither reads again nor opens twice", async () => {
  const row = await trayOffering("link");
  const before = tabCount();
  act(() => activateRow(row));
  act(() => activateRow(row));
  await settle();
  expect(native.read).toHaveBeenCalledTimes(1);
  await answer(reads, "https://ardia.dev/");
  expect(tabCount()).toBe(before + 1);
  expect(counted.mock.calls.filter(([field]) => field.startsWith("paste_and_go"))).toEqual([["paste_and_go_links"]]);
});

test("a tray opens without the last tray's paste row, and a refused paste keeps it gone", async () => {
  await trayOffering("link");
  act(() => dismissSearch());
  presentSearch("home", "");
  expect(pasteRow()).toBeUndefined();
  await answer(offers, "link");
  act(() => activateRow(pasteRow()!));
  await answer(reads, null);
  expect(pasteRow()).toBeUndefined();
  expect(counted.mock.calls).toEqual([["paste_and_go_unread"]]);
});

test("a paste that lands after its tray has gone opens nothing, and a tap begun in Incognito is never counted", async () => {
  const row = await trayOffering("text", true);
  act(() => useTabs.setState({ incognito: true }));
  const before = tabCount();
  act(() => activateRow(row));
  act(() => dismissSearch());
  act(() => useTabs.setState({ incognito: false }));
  await answer(reads, "sea otters");
  expect(tabCount()).toBe(before);
  expect(counted).not.toHaveBeenCalled();
});

test("an Incognito paste that lands while its tray is open opens a private tab and is never counted", async () => {
  act(() => useTabs.setState({ incognito: true }));
  const row = await trayOffering("text", true);
  const privates = currentTabs().privates.length;
  act(() => activateRow(row));
  await answer(reads, "sea otters");
  expect(currentTabs().privates.length).toBe(privates + 1);
  expect(counted).not.toHaveBeenCalled();
});

test("a paste that lands after its tray has gone is not counted", async () => {
  const row = await trayOffering("link");
  act(() => activateRow(row));
  act(() => dismissSearch());
  await answer(reads, "https://ardia.dev/");
  expect(counted).not.toHaveBeenCalled();
});

test("a row that offered a link but pasted text counts text", async () => {
  const row = await trayOffering("link");
  act(() => activateRow(row));
  await answer(reads, "sea otters");
  expect(counted.mock.calls.filter(([field]) => field.startsWith("paste_and_go"))).toEqual([["paste_and_go_texts"]]);
});

test("a refusal after the tray moved on leaves the new tray's paste row", async () => {
  const row = await trayOffering("link");
  act(() => activateRow(row));
  act(() => dismissSearch());
  await trayOffering("link");
  reads[0]!.resolve(null);
  await settle();
  expect(native.read).toHaveBeenCalledTimes(1);
  expect(pasteRow()).toBeDefined();
});
