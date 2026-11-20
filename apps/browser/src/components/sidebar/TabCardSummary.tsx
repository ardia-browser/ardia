import { View } from "react-native";
import { useSettings } from "../../state/browser/hooks";
import type { Tab } from "../../state/browser/types";
import { tabTitle } from "../../state/browser/model";
import { awayTitle } from "../../state/pins/organize";
import { useIsSleeping } from "../../state/tabs/tabLifecycle";
import { font, perLook, space, Symbol, Text } from "../ui";
import { isLocalFileUrl } from "../../lib/url";
import { lineHeight } from "../ui/tokens";
import { useTheme } from "../ui/theme";
import { AwayTitleLabel } from "./AwayTitle";
import { HOVER_CARD_HEADER } from "./hoverPlacement";
import { TabIcon } from "./TabIcon";
import { tabCardAddress } from "./tabCardAddress";
import { TAB_ROW } from "./tokens";

export function TabCardSummary({ tab }: { tab: Tab }) {
  const theme = useTheme();
  const sleeping = useIsSleeping(tab.id);
  const away = awayTitle(tab);
  const fullUrl = useSettings((s) => s.showFullUrlInTabHoverMenu);
  const shownAddress = tabCardAddress(tab.url, fullUrl);
  return (
    <>
      <View style={{ flexDirection: "row", alignItems: away ? "center" : "flex-start", gap: TAB_ROW.titleGap, minHeight: HOVER_CARD_HEADER }}>
        <View style={{ height: HOVER_CARD_HEADER, justifyContent: "center" }}>
          <TabIcon tabId={tab.id} url={tab.url} favicon={tab.favicon} icon={tab.customIcon} />
        </View>
        {away ? (
          <AwayTitleLabel away={away} color={theme.textPrimary} fontSize={font.body.fontSize} weight="medium" height={18} style={{ flex: 1 }} />
        ) : (
          <Text lines={TITLE_LINES} weight="medium" style={titleLines()}>
            {tabTitle(tab)}
          </Text>
        )}
      </View>
      {shownAddress ? (
        <Text lines={fullUrl ? 2 : 1} ellipsizeMode={isLocalFileUrl(tab.url) ? "head" : "tail"} size="caption" tone="textSecondary" style={urlLine()}>
          {shownAddress}
        </Text>
      ) : null}
      {sleeping ? (
        <View accessible accessibilityLabel="Web content has been discarded" style={{ flexDirection: "row", alignItems: "center", gap: space.xs, marginTop: space.xs }}>
          <Symbol name="moon.zzz" size={10} color={theme.textTertiary} style={{ width: 14, height: 14 }} />
          <Text size="caption" tone="textTertiary">
            This tab needs to reload
          </Text>
        </View>
      ) : null}
    </>
  );
}

const urlLine = perLook(() => ({ marginTop: space.xs, lineHeight: lineHeight.caption }));
const TITLE_LINES = 3;
const titleLines = perLook(() => ({ flex: 1, lineHeight: lineHeight.body, paddingVertical: Math.max(0, (HOVER_CARD_HEADER - lineHeight.body) / 2) }));
