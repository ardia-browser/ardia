import { StyleSheet, View } from "react-native";
import { useSettings, useTab } from "../../state/browser/hooks";
import { useTileTheme } from "../../state/favicons/tileTheme";
import { TabBadges } from "../media/TabBadges";
import { TabIcon } from "../sidebar/TabIcon";
import { TileUnread } from "../unread/UnreadBadge";
import { DockSelection, Text, withAlpha } from "../ui";
import { GlassFill, useGlass } from "../ui/Glass";
import { hex, useTheme } from "../ui/theme";
import { useSelectedTopApp } from "../../state/app/theme";
import { useMinimalism } from "../../state/windows/layout";
import { tileLetterOf } from "../../lib/tileLetter";
import { useSidebarTokens } from "../sidebar/tokens";
import { ITEM_HEIGHT, PINNED_CELL, PINNED_FACE_INSET, pinnedFaceRadius, PINNED_RING_STROKE } from "./tokens";

export function PinnedFace({ tabId, active, hovered, pressed, frame = "cell" }: { tabId: string; active: boolean; hovered: boolean; pressed: boolean; frame?: "cell" | "face" }) {
  const theme = useTheme();
  const tab = useTab(tabId);
  const tileTheme = useTileTheme(tab?.url ?? "", tab?.favicon, tab?.customIcon, tab?.profileId ?? "");
  const glass = useGlass();
  const badges = useSettings((st) => st.showTopAppBadges);
  const topApp = useSelectedTopApp();
  const minimal = useMinimalism();
  const quiet = useSidebarTokens();
  if (!tab) return null;
  const glassRing = active && glass;
  const compact = frame === "face";
  const face = compact
    ? StyleSheet.absoluteFillObject
    : { position: "absolute", left: PINNED_FACE_INSET, right: PINNED_FACE_INSET, top: PINNED_FACE_INSET, bottom: PINNED_FACE_INSET } as const;
  return (
    <View style={{ width: PINNED_CELL - (compact ? PINNED_FACE_INSET * 2 : 0), height: ITEM_HEIGHT - 1 - (compact ? PINNED_FACE_INSET * 2 : 0), alignItems: "center", justifyContent: "center" }}>
      {glassRing ? (
        <View style={face}>
          <GlassFill radius={pinnedFaceRadius()} state={pressed ? "pressed" : topApp === "outline" ? (hovered ? "lit" : "rest") : "active"} />
          <DockSelection
            image={tileTheme?.image}
            emoji={tileTheme?.emoji}
            theme={tileTheme?.theme.kind}
            fill={tileTheme?.theme.kind === "template" ? tileTheme.theme.fill : undefined}
            stroke={tileTheme?.theme.kind === "template" ? tileTheme.theme.stroke : undefined}
            cornerRadius={pinnedFaceRadius()}
            strokeWidth={topApp === "fill" ? 0 : PINNED_RING_STROKE}
            outline={topApp === "outline"}
            dark={theme.dark}
            glass
            colorRing
            style={StyleSheet.absoluteFill}
          />
        </View>
      ) : glass && (hovered || pressed) ? (
        <View style={face}>
          <GlassFill radius={pinnedFaceRadius()} state={pressed ? "pressed" : "lit"} />
        </View>
      ) : (active || hovered || pressed) && (
        <View
          style={{
            ...face,
            borderRadius: pinnedFaceRadius(),
            borderWidth: active && topApp === "outline" ? PINNED_RING_STROKE : 0,
            borderColor: theme.pinnedSelectedFill,
            backgroundColor: pressed ? theme.tabPressed : active && topApp !== "outline" ? theme.pinnedSelectedFill : hovered ? theme.tabHover : undefined,
          }}
        />
      )}
      <View pointerEvents="none">
        {minimal ? (
          <Text size="small" weight="medium" color={hex(withAlpha(theme.textTab, active ? quiet.quietActiveText : quiet.quietText))}>
            {tileLetterOf(tab.url, tab.customTitle ?? tab.title)}
          </Text>
        ) : (
          <TabIcon tabId={tab.id} url={tab.url} favicon={tab.favicon} icon={tab.customIcon} />
        )}
        <TabBadges tabId={tab.id} />
      </View>
      {badges ? <TileUnread tabId={tab.id} /> : null}
    </View>
  );
}
