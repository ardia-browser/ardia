import { View } from "react-native";
import { Button, Divider } from "../ui";
import type { ToolbarPalette } from "../ui/toolbarColors";
import { DEVELOPER_ICONS } from "../toolbar/developerIcons";
import { DEVELOPER_BAR } from "../toolbar/tokens";
import { OverflowButton } from "../extensions/ToolbarExtensions";
import { HOST_ACTIONS, type HostAction, type PageBarButton } from "../../lib/pluginPageBar";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { useShortcutHint, withShortcut } from "../../state/commands/commandShortcuts";
import { usePageEngine } from "../../state/engines/hooks";
import { splitViewAvailable } from "../../state/splits/splits";
import { DEVELOPER_BAR_ANCHOR } from "../../state/extensions/toolbarAnchors";
import { hostActionTarget, runHostAction } from "../../state/plugins/hostActions";

export const PAGE_BAR_ROW = { flexDirection: "row", alignItems: "center" } as const;

const DEVTOOLS: HostAction[] = ["console", "network", "inspect"];
const ICONS: Record<Exclude<HostAction, "address" | "extensions">, (typeof DEVELOPER_ICONS)[keyof typeof DEVELOPER_ICONS]> = {
  siteControls: DEVELOPER_ICONS.info,
  copyLink: DEVELOPER_ICONS.link,
  console: DEVELOPER_ICONS.console,
  network: DEVELOPER_ICONS.network,
  inspect: DEVELOPER_ICONS.inspect,
  split: DEVELOPER_ICONS.split,
};

type Props = { windowId: string; tabId: string; document: { url: string; at: number }; buttons: PageBarButton[]; palette: ToolbarPalette; look: "row" | "field"; active?: HostAction | null; onFocus?: () => void };

function usable(action: HostAction, webkit: boolean): boolean {
  if (DEVTOOLS.includes(action) && webkit) return false;
  if (action === "network") return PLATFORM_FEATURES.devToolsPanels;
  if (action === "split") return splitViewAvailable;
  return action !== "address";
}

function trimmed(buttons: PageBarButton[]): PageBarButton[] {
  const out: PageBarButton[] = [];
  for (const b of buttons) if (b !== "|" || (out.length && out.at(-1) !== "|")) out.push(b);
  while (out.at(-1) === "|") out.pop();
  return out;
}

export function PageBarButtons({ windowId, tabId, document, buttons, palette, look, active, onFocus }: Props) {
  const webkit = usePageEngine(tabId) === "webkit";
  const hints: Partial<Record<HostAction, string | undefined>> = { copyLink: useShortcutHint("copyUrl"), console: useShortcutHint("javaScriptConsole"), inspect: useShortcutHint("inspectElements") };
  const glyph = look === "row" ? DEVELOPER_BAR.glyph : undefined;
  const shown = trimmed(buttons.filter((b) => b === "|" || usable(b, webkit)));
  const press = (action: HostAction) => () => {
    onFocus?.();
    runHostAction(action, windowId, tabId);
  };
  return (
    <View style={PAGE_BAR_ROW}>
      {shown.map((b, i) => {
        if (b === "|") return <Divider key={`divider-${i}`} vertical length={DEVELOPER_BAR.dividerLength} color={palette.divider} style={{ marginHorizontal: DEVELOPER_BAR.groupGap }} />;
        if (b === "address") return null;
        if (b === "extensions")
          return <OverflowButton key={b} windowId={windowId} tabId={tabId} hidden={[]} palette={palette} slot={DEVELOPER_BAR_ANCHOR} asset={DEVELOPER_ICONS.extensions} glyph={DEVELOPER_BAR.extensionsGlyph} mayActivate={() => hostActionTarget("extensions", windowId, tabId, document)} onActivate={() => runHostAction("extensions", windowId, tabId)} />;
        return (
          <Button
            key={b}
            variant="icon"
            toolbar
            palette={palette}
            asset={ICONS[b]}
            glyph={glyph}
            look={look}
            active={active === b}
            onPress={press(b)}
            tooltip={withShortcut(HOST_ACTIONS[b].title, hints[b] ?? undefined)}
          />
        );
      })}
    </View>
  );
}
