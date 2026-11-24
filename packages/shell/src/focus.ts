import type { FocusNative } from "./generated/native";

type KeyHoldDrop = "modified" | "edit" | "character" | "dead" | "ime" | "mouse" | "window" | "command" | "cancelled" | "focus" | "reload" | "site" | "capacity" | "timeout";

export type KeyHoldCounts = { holds: number; replayed: number; drops: Partial<Record<KeyHoldDrop, number>> };

export type KeyHoldNative = { keyHoldCounts(): KeyHoldCounts };

export type { FocusNative };
