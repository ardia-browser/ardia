import { restorableState } from "@ardia/phone-native";

export const restoredValue = (key: string) => restorableState.get(key);

export const keepRestorable = (key: string, value: string | null) => restorableState.set(key, value);
