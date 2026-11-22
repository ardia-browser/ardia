import { t } from "../../lib/uiLanguage";
export const MENU_OPENERS = [t(`MenuTrigger`), t(`FloatingMenu`), t(`Menu`), t(`PlusMenuButton`), t(`CardMenu`), t(`DeckCardMenu`), t(`CardMenuAt`), t(`TabsMenuTrigger`), t(`PressMenu`), t(`MoreMenu`), t(`ConfirmSheet`), t(`ActionSheet`), t(`ContextMenu`), t(`ContextMenuView`)] as const;

export const OPENER_DEFINITIONS = ["ui/Menu.tsx", "ui/MenuTrigger.tsx", "ui/ActionSheet.tsx"] as const;
