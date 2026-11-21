import "react-native-gesture-handler/jestSetup";

jest.mock("react-native-gesture-handler/lib/module/handlers/gestures/installUIRuntimeBindings", () => ({ installUIRuntimeBindings: () => undefined }));

Object.assign(globalThis, { jest });

require("react-native-reanimated").setUpTests();

jest.mock("react-native-reanimated", () => {
  const actual = jest.requireActual("react-native-reanimated");
  const { onUiThread, fromRemote, trust, workletOnly } = jest.requireActual("./uiRuntime");
  const ui = onUiThread;
  for (const value of Object.values(actual)) if (typeof value === "function") trust(value);
  const runOnJS = trust((fn: unknown) => actual.runOnJS(fromRemote(fn)));
  return {
    ...actual,
    __esModule: true,
    runOnJS,
    useAnimatedStyle: (updater: unknown, ...rest: unknown[]) => actual.useAnimatedStyle(ui(updater), ...rest),
    useAnimatedProps: (updater: unknown, ...rest: unknown[]) => actual.useAnimatedProps(ui(updater), ...rest),
    useDerivedValue: (updater: unknown, ...rest: unknown[]) => actual.useDerivedValue(ui(updater), ...rest),
    useAnimatedReaction: (prepare: unknown, react: unknown, ...rest: unknown[]) => actual.useAnimatedReaction(ui(prepare), ui(react), ...rest),
    useFrameCallback: (callback: unknown, ...rest: unknown[]) => actual.useFrameCallback(ui(callback), ...rest),
    withTiming: trust((to: unknown, config: unknown, done: unknown) => actual.withTiming(to, config, ui(workletOnly(done)))),
    withSpring: trust((to: unknown, config: unknown, done: unknown) => actual.withSpring(to, config, ui(workletOnly(done)))),
    withDecay: trust((config: unknown, done: unknown) => actual.withDecay(config, ui(workletOnly(done)))),
  };
});

{
  const { onUiThread } = jest.requireActual("./uiRuntime");
  const gestures = jest.requireActual("react-native-gesture-handler/lib/module/handlers/gestures/gesture");
  const setters: [object, string[]][] = [
    [gestures.BaseGesture.prototype, ["onBegin", "onStart", "onEnd", "onFinalize", "onTouchesDown", "onTouchesMove", "onTouchesUp", "onTouchesCancelled"]],
    [gestures.ContinousBaseGesture.prototype, ["onUpdate", "onChange"]],
  ];
  for (const [prototype, names] of setters) {
    for (const name of names) {
      const original = (prototype as Record<string, (callback: unknown) => unknown>)[name]!;
      (prototype as Record<string, (callback: unknown) => unknown>)[name] = function (this: unknown, callback: unknown) {
        return original.call(this, onUiThread(callback));
      };
    }
  }
}

jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default);

jest.mock("@expo/ui/swift-ui", () => {
  const { useRef } = jest.requireActual<typeof import("react")>("react");
  return {
    ...jest.requireActual<object>("@expo/ui/swift-ui"),
    useNativeState: <T,>(initial: T) => {
      const state = useRef<{ value: T; get: () => T; set: (next: T) => void; onChange: null } | null>(null);
      if (!state.current) {
        const made = { value: initial, get: () => made.value, set: (next: T) => void (made.value = next), onChange: null };
        state.current = made;
      }
      return state.current;
    },
  };
});

jest.mock("../../src/platform/appInfo", () => ({ ...jest.requireActual("../../src/platform/appInfo"), appVersion: () => "Ardia Dev (1)" }));

jest.mock("../../src/platform/database", () => {
  const { renderDatabase } = require("./renderDatabase");
  return { openSqlDatabase: () => renderDatabase(), openMemoryDatabase: () => renderDatabase() };
});

const PHONE_WINDOW = { width: 393, height: 873, scale: 3, fontScale: 1 };
require("react-native").Dimensions.set({ window: PHONE_WINDOW, screen: PHONE_WINDOW });

