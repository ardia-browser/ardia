import { memo } from "react";
import { Animated, Image, Pressable, StyleSheet, View } from "react-native";
import { Button, ContextMenuArea, Divider, monoFace, Text, WindowDragRegion } from "../ui";
import { ToolbarRowContext } from "../ui/toolbarRowContext";
import { useEasedColor } from "../ui/toolbarColors";
import { isLight } from "../../lib/color";
import { usePages } from "../../state/tabs/pageState";
import { togglePopover } from "../../state/tabs/popoverDismiss";
import { showUrlBarMenu } from "../../state/omnibox/paste";
import { copyPageUrl } from "../../state/site/selection";
import { openBarFromDeveloperBar, showSplitSidesMenu } from "../../state/site/developerMode";
import { splitViewAvailable } from "../../state/splits/splits";
import { useShortcutHint, withShortcut } from "../../state/commands/commandShortcuts";
import { noteDeveloperBarPress, type DeveloperBarAction } from "../../state/telemetry/developerModeCounts";
import { OverflowButton } from "../extensions/ToolbarExtensions";
import { useSitePalette } from "./useSitePalette";
import { useToolbarTab } from "./Toolbar";
import { DeveloperToolsButtons, DEVELOPER_BUTTON_ROW } from "./DeveloperToolsButtons";
import { DEVELOPER_ICONS } from "./developerIcons";
import { withoutUserInfo } from "../../lib/url";
import { DEVELOPER_BAR_ANCHOR } from "../../state/extensions/toolbarAnchors";
import { DEVELOPER_BAR, DEVELOPER_ROW as ROW } from "./tokens";

const STRIPES = {
  lightInk: require("../../../assets/dev-stripes-light-ink.png"),
  darkInk: require("../../../assets/dev-stripes-dark-ink.png"),
};

export const DeveloperBar = memo(function DeveloperBar({ tabId, windowId }: { tabId: string; windowId: string }) {
  const tab = useToolbarTab(tabId);
  const palette = useSitePalette(tabId);
  const band = useEasedColor(palette.background);
  const popover = usePages((p) => p.popover[tabId] ?? null);
  const copyHint = useShortcutHint("copyUrl");
  if (!tab) return null;
  const press = (action: DeveloperBarAction, run: () => void) => () => {
    noteDeveloperBarPress(action);
    run();
  };
  const ink = isLight(palette.text) ? "lightInk" : "darkInk";
  const divider = <Divider vertical length={DEVELOPER_BAR.dividerLength} color={palette.divider} style={{ marginHorizontal: DEVELOPER_BAR.groupGap }} />;

  return (
    <ToolbarRowContext.Provider value={ROW}>
      <View testID="ardia.developerBar" style={{ height: DEVELOPER_BAR.height }}>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: band }]} />
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: DEVELOPER_BAR.stripeOpacity[ink] }]}>
          <Image source={STRIPES[ink]} resizeMode="repeat" style={{ flex: 1, width: undefined, height: undefined }} />
        </View>
        <WindowDragRegion style={StyleSheet.absoluteFill} />
        <View pointerEvents="box-none" style={{ flex: 1, flexDirection: "row", alignItems: "center", paddingLeft: DEVELOPER_BAR.leadingEdge, paddingRight: DEVELOPER_BAR.trailingEdge }}>
          <Button
            variant="icon"
            toolbar
            palette={palette}
            asset={DEVELOPER_ICONS.info}
            glyph={DEVELOPER_BAR.glyph}
            look="row"
            active={popover === "siteControls"}
            onPress={press("siteControls", () => togglePopover(tabId, "siteControls"))}
            tooltip="Site Controls"
          />
          <ContextMenuArea style={{ flex: 1 }} onContextMenu={() => void showUrlBarMenu(tab)}>
            <Pressable accessibilityRole="button" accessibilityLabel="Edit Address" onPress={press("address", () => openBarFromDeveloperBar(windowId, tabId, tab.url))} style={{ flex: 1, height: ROW.button, justifyContent: "center", paddingLeft: DEVELOPER_BAR.urlGap, paddingRight: DEVELOPER_BAR.groupGap }}>
              <Text numberOfLines={1} ellipsizeMode="middle" color={palette.text} style={[monoFace(), { fontSize: DEVELOPER_BAR.urlSize }]}>
                {withoutUserInfo(tab.url)}
              </Text>
            </Pressable>
          </ContextMenuArea>
          <View style={DEVELOPER_BUTTON_ROW}>
            <Button variant="icon" toolbar palette={palette} asset={DEVELOPER_ICONS.link} glyph={DEVELOPER_BAR.glyph} look="row" onPress={press("copyLink", () => void copyPageUrl(tabId))} tooltip={withShortcut("Copy URL", copyHint)} />
            {divider}
            <DeveloperToolsButtons tabId={tabId} palette={palette} look="row" glyph={DEVELOPER_BAR.glyph} />
            {divider}
            <OverflowButton windowId={windowId} tabId={tabId} palette={palette} slot={DEVELOPER_BAR_ANCHOR} asset={DEVELOPER_ICONS.extensions} glyph={DEVELOPER_BAR.extensionsGlyph} onActivate={() => noteDeveloperBarPress("extensions")} />
            {splitViewAvailable && (
              <Button variant="icon" toolbar palette={palette} asset={DEVELOPER_ICONS.split} glyph={DEVELOPER_BAR.glyph} look="row" onPress={press("split", () => void showSplitSidesMenu(tabId))} tooltip="Split View Options" />
            )}
          </View>
        </View>
        <Divider color={palette.divider} style={BOTTOM_LINE} />
      </View>
    </ToolbarRowContext.Provider>
  );
});

const BOTTOM_LINE = { position: "absolute", left: 0, right: 0, bottom: 0 } as const;
