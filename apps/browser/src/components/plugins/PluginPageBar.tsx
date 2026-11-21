import { memo } from "react";
import { Animated, Image, Pressable, StyleSheet, View } from "react-native";
import { ContextMenuArea, Divider, monoFace, Text, WindowDragRegion } from "../ui";
import { ToolbarRowContext } from "../ui/toolbarRowContext";
import { useEasedColor } from "../ui/toolbarColors";
import { useSitePalette } from "../toolbar/useSitePalette";
import { useToolbarTab } from "../toolbar/Toolbar";
import { DEVELOPER_BAR, DEVELOPER_ROW as ROW } from "../toolbar/tokens";
import { isLight } from "../../lib/color";
import { withoutUserInfo } from "../../lib/url";
import type { HostAction } from "../../lib/pluginPageBar";
import { usePages } from "../../state/tabs/pageState";
import { showUrlBarMenu } from "../../state/omnibox/paste";
import { runHostAction } from "../../state/plugins/hostActions";
import type { PageBarMatch } from "../../state/plugins/pageBar";
import { PAGE_BAR_ROW, PageBarButtons } from "./PageBarButtons";

const STRIPES = {
  lightInk: require("../../../assets/dev-stripes-light-ink.png"),
  darkInk: require("../../../assets/dev-stripes-dark-ink.png"),
};

export const PAGE_BAR_HEIGHT = DEVELOPER_BAR.height;

export const PluginPageBar = memo(function PluginPageBar({ tabId, windowId, match }: { tabId: string; windowId: string; match: PageBarMatch }) {
  const tab = useToolbarTab(tabId);
  const palette = useSitePalette(tabId);
  const band = useEasedColor(palette.background);
  const popover = usePages((p) => p.popover[tabId] ?? null);
  if (!tab) return null;
  const ink = isLight(palette.text) ? "lightInk" : "darkInk";
  const buttons = match.spec.buttons;
  const at = buttons.indexOf("address");
  const leading = at < 0 ? [] : buttons.slice(0, at);
  const trailing = at < 0 ? buttons : buttons.slice(at + 1);
  const active: HostAction | null = popover === "siteControls" ? "siteControls" : null;
  const label = (
    <Text numberOfLines={1} ellipsizeMode="middle" color={palette.text} style={[monoFace(), { fontSize: DEVELOPER_BAR.urlSize }]}>
      {withoutUserInfo(match.url)}
    </Text>
  );
  const labelStyle = { flex: 1, height: ROW.button, justifyContent: "center", paddingLeft: DEVELOPER_BAR.urlGap, paddingRight: DEVELOPER_BAR.groupGap } as const;

  return (
    <ToolbarRowContext.Provider value={ROW}>
      <View testID="ardia.pluginPageBar" accessibilityLabel={`${match.plugin} page bar`} style={{ height: PAGE_BAR_HEIGHT }}>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: band }]} />
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: DEVELOPER_BAR.stripeOpacity[ink] }]}>
          <Image source={STRIPES[ink]} resizeMode="repeat" style={{ flex: 1, width: undefined, height: undefined }} />
        </View>
        <WindowDragRegion style={StyleSheet.absoluteFill} />
        <View pointerEvents="box-none" style={{ flex: 1, flexDirection: "row", alignItems: "center", paddingLeft: DEVELOPER_BAR.leadingEdge, paddingRight: DEVELOPER_BAR.trailingEdge }}>
          {leading.length ? <PageBarButtons windowId={windowId} tabId={tabId} buttons={leading} palette={palette} look="row" active={active} /> : null}
          <ContextMenuArea style={{ flex: 1 }} onContextMenu={() => void showUrlBarMenu(tab)}>
            {at < 0 ? (
              <View style={labelStyle}>{label}</View>
            ) : (
              <Pressable accessibilityRole="button" accessibilityLabel="Edit Address" onPress={() => runHostAction("address", windowId, tabId)} style={labelStyle}>
                {label}
              </Pressable>
            )}
          </ContextMenuArea>
          <View style={PAGE_BAR_ROW}>
            <PageBarButtons windowId={windowId} tabId={tabId} buttons={trailing} palette={palette} look="row" active={active} />
          </View>
        </View>
        <Divider color={palette.divider} style={BOTTOM_LINE} />
      </View>
    </ToolbarRowContext.Provider>
  );
});

const BOTTOM_LINE = { position: "absolute", left: 0, right: 0, bottom: 0 } as const;
