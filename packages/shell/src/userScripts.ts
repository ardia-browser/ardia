import type { EventSubscription } from "expo-modules-core";
import type { UserScriptsNative } from "./generated/native";

export type UserScriptsFolder = { token?: string } & (
  | { state: "empty" | "busy" | "pending"; generation?: number }
  | { state: "absent"; generation: number; path: string }
  | { state: "invalid"; generation?: number; error: string; path?: string }
  | { state: "ready"; generation: number; path: string }
);

export type { UserScriptsNative };
