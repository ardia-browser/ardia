import { appliedDark, preferredScheme, type MacLook, type PreferredScheme, type SchemeChoice } from "./appearance.ts";
import type { Design } from "./design.ts";
import type { ProfileTheme } from "@ardia/core/src/theme.ts";
import { activeCustomLook, lookForApp, nativeLookColors, themedScheme, type LookSource, type NativeThemeLook, type PresetSpec, type ProfileLook } from "./profileLook.ts";

export type LaunchLookSlot = { look?: NativeThemeLook; dark: boolean };

export type SavedLaunchLook = { color?: string; themeColors: string[]; darkThemeColors?: string[]; themeLooks: { light: LaunchLookSlot; dark: LaunchLookSlot } };

function slotFor(look: ProfileLook, preferred: PreferredScheme, systemDark: boolean): LaunchLookSlot {
  const dark = appliedDark(preferred, systemDark);
  const themeLook = nativeLookColors(look, dark).themeLook;
  return themeLook ? { look: themeLook, dark } : { dark };
}

export function launchLookFor(look: ProfileLook, preferred: PreferredScheme): SavedLaunchLook {
  const { color, themeColors, darkThemeColors } = nativeLookColors(look, false);
  return {
    ...(color ? { color } : {}),
    themeColors,
    ...(darkThemeColors ? { darkThemeColors } : {}),
    themeLooks: { light: slotFor(look, preferred, false), dark: slotFor(look, preferred, true) },
  };
}

export type LaunchLookState = {
  design: Design;
  schemeChoice: SchemeChoice;
  colorChoice: string | null;
  customTheme: ProfileTheme | null;
  syncEnabled: boolean;
  macLook: MacLook | null;
  space: LookSource | null;
};

export function launchLookOf(state: LaunchLookState, presets: readonly PresetSpec[], fallback: string): SavedLaunchLook {
  const look = lookForApp(state.colorChoice, state.syncEnabled, state.space, presets, fallback, state.customTheme);
  const chosen = preferredScheme(state.design, state.schemeChoice, state.macLook);
  const scheme = state.design === "material" ? chosen : themedScheme(activeCustomLook(state.colorChoice, state.customTheme, state.syncEnabled, state.space), chosen);
  return launchLookFor(look, scheme);
}

export type LaunchLookWriter = { settle: () => void; leave: () => void };

export function launchLookWriter(read: () => SavedLaunchLook | null, write: (saved: SavedLaunchLook) => void): LaunchLookWriter {
  let written: string | null = null;
  const flush = (force: boolean) => {
    const current = read();
    if (!current) return;
    const key = JSON.stringify(current);
    if (!force && key === written) return;
    written = key;
    write(current);
  };
  return { settle: () => flush(false), leave: () => flush(true) };
}

export type LaunchLookSources = { ready: boolean; syncOffered: boolean; syncLoaded: boolean; needsSync?: boolean };

export const launchLookSourcesLoaded = ({ ready, syncOffered, syncLoaded, needsSync = true }: LaunchLookSources) => ready && (!syncOffered || syncLoaded || !needsSync);

export const launchLookNeedsSync = ({ colorChoice, schemeChoice, design }: Pick<LaunchLookState, "colorChoice" | "schemeChoice" | "design">) =>
  colorChoice === null || (design !== "original" && schemeChoice === "matchMac");
