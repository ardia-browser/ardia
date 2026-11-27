import { appliedDark, type PreferredScheme } from "./appearance.ts";
import { nativeLookColors, type NativeThemeLook, type ProfileLook } from "./profileLook.ts";

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

export type LaunchLookWriter = { settle: (saved: SavedLaunchLook) => void; leave: () => void };

export function launchLookWriter(write: (saved: SavedLaunchLook) => void): LaunchLookWriter {
  let settled: SavedLaunchLook | null = null;
  let written: string | null = null;
  const flush = (force: boolean) => {
    if (!settled) return;
    const key = JSON.stringify(settled);
    if (!force && key === written) return;
    written = key;
    write(settled);
  };
  return {
    settle: (saved) => {
      settled = saved;
      flush(false);
    },
    leave: () => flush(true),
  };
}
