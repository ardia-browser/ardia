import type { AppIcon, UpdaterState } from "../../platform/app";

export type Capability = "loading" | "available" | "unavailable";

export type SettingsCapabilities = { updates: Capability; updateChannel: Capability; appIcon: Capability };

export const updatesCapability = (state: UpdaterState | undefined): Capability => (state === undefined ? "loading" : state.available ? "available" : "unavailable");

export const updateChannelCapability = (state: UpdaterState | undefined): Capability =>
  state === undefined ? "loading" : state.available && state.channel ? "available" : "unavailable";

export const appIconCapability = (choices: { icons: readonly AppIcon[] } | undefined): Capability =>
  choices === undefined ? "loading" : choices.icons.length >= 2 ? "available" : "unavailable";
