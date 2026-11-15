import { createContext, useContext, useMemo } from "react";
import { useSelectedTabGlowSetting } from "../../state/app/theme";
import { useShortcutHint } from "../../state/commands/commandShortcuts";
import { DEFAULT_SETTINGS } from "../../state/settings/settings";
import { useMinimalism } from "../../state/windows/layout";
import { selectedTabGlow, useTheme, type SelectedTabGlowLevel } from "../ui/theme";

export type SidebarRowLook = { glow: SelectedTabGlowLevel; backToPinHint: string | undefined; closeTabHint: string | undefined; quiet: boolean };

export const SidebarRowLookContext = createContext<SidebarRowLook>({ glow: DEFAULT_SETTINGS.selectedTabGlow, backToPinHint: undefined, closeTabHint: undefined, quiet: false });

export function useSidebarRowLookSource(): SidebarRowLook {
  const quiet = useMinimalism();
  const chosenGlow = useSelectedTabGlowSetting();
  const glow = quiet ? "off" : chosenGlow;
  const backToPinHint = useShortcutHint("returnToPinnedUrl");
  const closeTabHint = useShortcutHint("closeTab");
  return useMemo(() => ({ glow, backToPinHint, closeTabHint, quiet }), [glow, backToPinHint, closeTabHint, quiet]);
}

export const useQuietRows = () => useContext(SidebarRowLookContext).quiet;

export const useSidebarRowLook = () => useContext(SidebarRowLookContext);

export function useSelectedTabGlow() {
  return selectedTabGlow(useTheme(), useSidebarRowLook().glow);
}
