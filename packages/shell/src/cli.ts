import type { EventSubscription } from "expo-modules-core";
import type { CliNative } from "./generated/native";

export type CliInstallResult = {
  ok: boolean;
  appVersion: string;
  binPath?: string;
  version?: string;
  rcFile?: string;
  error?: string;
  installedVersion?: string | null;
  lines: string[];
};

export type { CliNative };
