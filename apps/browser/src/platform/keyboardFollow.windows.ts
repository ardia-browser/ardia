import type { KeptFollows, KeptFollowsNative } from "@ardia/shell";
import { requireNativeModule } from "expo-modules-core";
import type { FollowKeyboard } from "./keyboardFollow";
import { t } from "../lib/uiLanguage";


export type { FollowKeyboard } from "./keyboardFollow";

export const followKeyboard: FollowKeyboard | null = (tabId, windowId) => requireNativeModule<{ followKeyboard: FollowKeyboard }>(t(`ArdiaTabs`)).followKeyboard(tabId, windowId);

export const takeKeptFollows = (): KeptFollows => requireNativeModule<KeptFollowsNative>(t(`ArdiaTabs`)).takeKeptFollows();
