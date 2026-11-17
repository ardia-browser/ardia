import { showDeck } from "../../state/browse/store";
import { SCREEN_COLUMN, type ScreenColumn } from "../../state/app/screenLayout";
import { openSettings } from "../../state/settings/hooks";
import { tabsLayout } from "../ui";
import { GlassCircleButton } from "../tabs/ChromeButtons";
import { PlusMenuButton } from "../tabs/DeckBottomBar";
import { columnMenuPlace, SideColumn } from "./SideColumn";

export function StartColumn({ column, width, dark, incognito, menusShown }: { column: ScreenColumn; width: number; dark: boolean; incognito: boolean; menusShown: boolean }) {
  const plusTop = SCREEN_COLUMN.top + SCREEN_COLUMN.button + SCREEN_COLUMN.spacing;
  return (
    <SideColumn column={column} width={width} testID="startColumn">
      <GlassCircleButton icon="squareOnSquare" label="Tabs" testID="startBarTabs" diameter={SCREEN_COLUMN.button} dark={dark} incognito={incognito} onPress={showDeck} />
      <PlusMenuButton
        width={SCREEN_COLUMN.button}
        label={incognito ? "New Incognito Tab" : "New Tab"}
        testID="startBarPlus"
        dark={dark}
        incognito={incognito}
        place={{ ...columnMenuPlace(column, width, plusTop), width: tabsLayout.menuWidth }}
        menusShown={menusShown}
      />
      <GlassCircleButton icon="gearshape" label="Settings" testID="startBarSettings" diameter={SCREEN_COLUMN.button} dark={dark} incognito={incognito} onPress={() => openSettings()} />
    </SideColumn>
  );
}
