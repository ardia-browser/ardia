import type { ConfigNative } from "./generated/native";

export type ConfigFileRead =
  | { status: "ok"; text: string; stamp?: string }
  | { status: "missing" | "notFile" | "tooBig" | "unreadable"; text?: undefined; stamp?: string };

export type { ConfigNative };
