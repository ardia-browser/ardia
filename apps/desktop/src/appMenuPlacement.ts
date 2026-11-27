import { IN_WINDOW_APP_MENU } from "@platform/appMenuButton";
import { useMenuBesideWindowButtons } from "./sidebarHeaderLayout";

export const inWindowAppMenu = IN_WINDOW_APP_MENU;

export function useAppMenuInHeader(): boolean {
  const besideWindowButtons = useMenuBesideWindowButtons();
  return IN_WINDOW_APP_MENU && !besideWindowButtons;
}
