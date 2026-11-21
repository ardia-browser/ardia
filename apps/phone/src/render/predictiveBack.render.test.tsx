type Listener = (event?: { progress: number; edge: "left" | "right" }) => void;

const listeners = new Map<string, Set<Listener>>();
const enabled: boolean[] = [];
const fakeNative = {
  setTrayBackEnabled: (value: boolean) => enabled.push(value),
  addListener: (name: string, listener: Listener) => {
    const set = listeners.get(name) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(name, set);
    return { remove: () => set.delete(listener) };
  },
};

jest.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => fakeNative }));

const emit = (name: string, event?: { progress: number; edge: "left" | "right" }) => listeners.get(name)?.forEach((listener) => listener(event));
const wiredCount = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);

const load = () => jest.requireActual<typeof import("@ardia/phone-native/src/back")>("@ardia/phone-native/src/back");

beforeEach(() => {
  jest.resetModules();
  listeners.clear();
  enabled.length = 0;
});

test("the surface that opened last gets Back's progress and commit, and the one under it gets Back again once it closes", () => {
  const { predictiveBack } = load();
  const seen: string[] = [];
  const sheet = predictiveBack.claim({ onProgress: (progress) => seen.push(`sheet ${progress}`), onCommit: () => seen.push("sheet commit") });
  const menu = predictiveBack.claim({ onProgress: (progress) => seen.push(`menu ${progress}`), onCancel: () => seen.push("menu cancel") });
  emit("onBackProgress", { progress: 0.4, edge: "left" });
  emit("onBackCancel");
  menu.remove();
  emit("onBackProgress", { progress: 0.7, edge: "right" });
  emit("onBackCommit");
  sheet.remove();
  expect(seen).toEqual(["menu 0.4", "menu cancel", "sheet 0.7", "sheet commit"]);
  expect(enabled).toEqual([true, true, true, false]);
  expect(wiredCount()).toBe(0);
});

test("the tray keeps its old API on top of the claims and a sheet over the tray takes Back from it", () => {
  const { predictiveBack, trayBack } = load();
  const tray: number[] = [];
  const listening = trayBack.listen({ onProgress: (progress) => tray.push(progress) });
  trayBack.setEnabled(true);
  trayBack.setEnabled(true);
  emit("onBackProgress", { progress: 0.2, edge: "left" });
  const sheet = predictiveBack.claim({});
  emit("onBackProgress", { progress: 0.5, edge: "left" });
  sheet.remove();
  emit("onBackProgress", { progress: 0.9, edge: "left" });
  trayBack.setEnabled(false);
  listening.remove();
  expect(tray).toEqual([0.2, 0.9]);
  expect(enabled[enabled.length - 1]).toBe(false);
});
