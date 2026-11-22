import { View } from "react-native";
import { Button } from "../ui";
import { DEVELOPER_ICONS } from "./developerIcons";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import type { ToolbarPalette } from "../ui/toolbarColors";
import { useShortcutHint, withShortcut } from "../../state/commands/commandShortcuts";
import { webviews } from "../../state/tabs/webviewHandles";
import { noteDeveloperBarPress } from "../../state/telemetry/developerModeCounts";
import { usePageEngine } from "../../state/engines/hooks";
import { t } from "../../lib/uiLanguage";


export const DEVELOPER_BUTTON_ROW = { flexDirection: "row", alignItems: "center" } as const;

export function DeveloperToolsButtons({ tabId, palette, look, onFocus, glyph }: { tabId: string; palette: ToolbarPalette; look: "row" | "field"; onFocus?: () => void; glyph?: number }) {
  const consoleHint = useShortcutHint("javaScriptConsole");
  const inspectHint = useShortcutHint("inspectElements");
  const engine = usePageEngine(tabId);
  if (engine === "webkit") return null;
  const open = (panel: "console" | "network" | "inspect") => () => {
    onFocus?.();
    noteDeveloperBarPress(panel);
    void webviews.get(tabId)?.showDevTools(panel);
  };
  return (
    <View style={DEVELOPER_BUTTON_ROW}>
      <Button variant="icon" toolbar palette={palette} asset={DEVELOPER_ICONS.console} glyph={glyph} look={look} onPress={open("console")} tooltip={withShortcut(t(`Toggle Console`), consoleHint)} />
      {PLATFORM_FEATURES.devToolsPanels && (
        <Button variant="icon" toolbar palette={palette} asset={DEVELOPER_ICONS.network} glyph={glyph} look={look} onPress={open("network")} tooltip={t(`Toggle Network Panel`)} />
      )}
      <Button variant="icon" toolbar palette={palette} asset={DEVELOPER_ICONS.inspect} glyph={glyph} look={look} onPress={open("inspect")} tooltip={withShortcut(t(`Inspect Element`), inspectHint)} />
    </View>
  );
}
