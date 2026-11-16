import assert from "node:assert/strict";
import { test } from "node:test";

const listeners = [];
let on = true;
globalThis.acTestNativeModules = {
  ...globalThis.acTestNativeModules,
  ArdiaShell: {
    isHighContrast: () => Promise.resolve(on),
    addListener: (eventName, listener) => {
      listeners.push([eventName, listener]);
      return { remove: () => listeners.splice(listeners.findIndex(([, l]) => l === listener), 1) };
    },
  },
};
const { highContrastOn, onHighContrast } = await import("./highContrast.windows.ts");

test("a Windows contrast theme is read from the shell, and a failing call reads as off", async () => {
  assert.equal(await highContrastOn(), true);
  on = false;
  assert.equal(await highContrastOn(), false);
  globalThis.acTestNativeModules.ArdiaShell.isHighContrast = () => Promise.reject(new Error("gone"));
  assert.equal(await highContrastOn(), false);
});

test("only the shell's highContrast events reach the listener, until it stops listening", () => {
  const heard = [];
  const stop = onHighContrast((value) => heard.push(value));
  for (const [, listener] of listeners) {
    listener({ type: "appearance", dark: true });
    listener({ type: "highContrast", on: true });
    listener({ type: "highContrast", on: "yes" });
    listener(null);
  }
  assert.deepEqual(heard, [true]);
  stop();
  assert.equal(listeners.length, 0);
});
