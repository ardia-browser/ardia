import assert from "node:assert/strict";
import { test } from "node:test";
import { turboModules } from "../test-native/reactNative.ts";

const copied = [];
turboModules.ArdiaShell = { copyText: (text) => void copied.push(text) };

const { requireNativeModule } = await import("../../../../packages/expo-windows/src/modules.ts");

test("on Windows, copyURL writes the address through the native copyText instead of a silent placeholder", () => {
  const shell = requireNativeModule("ArdiaShell");
  shell.copyURL("https://shop.example/item?id=7");
  shell.copyText("plain");
  assert.deepEqual(copied, ["https://shop.example/item?id=7", "plain"]);
});
