import { requireOptionalNativeModule } from "expo-modules-core";
import type { Subscription } from "./pageTypes";

export type KeyboardWillChange = { source: number; target: number; durationMs: number; navigationBar: number };

export type KeyboardDidChange = { height: number; navigationBar: number };

type KeyboardNative = {
  addListener(eventName: "onKeyboardWillChange", listener: (event: KeyboardWillChange) => void): Subscription;
  addListener(eventName: "onKeyboardDidChange", listener: (event: KeyboardDidChange) => void): Subscription;
  current?(): KeyboardDidChange;
};

const native = requireOptionalNativeModule<KeyboardNative>("ArdiaPhoneKeyboard");

const none: Subscription = { remove() {} };

export const keyboard = {
  isAvailable: (): boolean => native !== null,
  current: (): KeyboardDidChange | null => native?.current?.() ?? null,
  addWillChangeListener: (listener: (event: KeyboardWillChange) => void): Subscription =>
    native ? native.addListener("onKeyboardWillChange", listener) : none,
  addDidChangeListener: (listener: (event: KeyboardDidChange) => void): Subscription =>
    native ? native.addListener("onKeyboardDidChange", listener) : none,
};
