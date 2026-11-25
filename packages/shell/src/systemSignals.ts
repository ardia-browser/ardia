import type { EventSubscription } from "expo-modules-core";
import type { SystemSignalsNative } from "./generated/native";

export type SystemSignal = { type: "sleep" } | { type: "wake" } | { type: "idle"; threshold: number; idle: boolean };

export type MovedDownload = { ok: true; path: string } | { ok: false; reason: string; stagedPath?: string; strayPath?: string };

export type { SystemSignalsNative };
