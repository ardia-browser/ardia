import { useEffect } from "react";
import { Pressable, View } from "react-native";
import { goToNoticedTab, holdNewTabNotice, usePaneNewTabNotice } from "../../state/tabs/newTabNotice";
import { capsule, ClosingView, space, Symbol, Text, useHover, useLiveWhile, usePresence, tapActivates } from "../ui";
import { useTheme } from "../ui/theme";
import { Hud } from "./Hud";
import { NEW_TAB_NOTICE, windowColors } from "./tokens";

export function NewTabNotice({ windowId, tabId, right, top, enter = false }: { windowId: string; tabId: string; right: number; top: number; enter?: boolean }) {
  const theme = useTheme();
  const notice = usePaneNewTabNotice(windowId, tabId);
  const { shown, appear } = usePresence(notice, NEW_TAB_NOTICE.motion, enter);
  const { hovered, hoverProps } = useHover();
  const hover = !!notice && hovered;
  const live = useLiveWhile(!notice);
  useEffect(() => {
    if (!notice || !hover) return;
    holdNewTabNotice(windowId, notice, true);
    return () => holdNewTabNotice(windowId, notice, false);
  }, [hover, notice, windowId]);
  if (!shown) return null;
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", right, top }}>
      <ClosingView
        closing={!notice}
        pointerEvents="auto"
        style={{
          opacity: appear,
          transform: [{ translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [-NEW_TAB_NOTICE.rise, 0] }) }, { scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }],
        }}
      >
        <View {...hoverProps} style={POINTER}>
          <Pressable disabled={!notice} onPress={live(() => goToNoticedTab(windowId, shown))} onAccessibilityTap={tapActivates(live(() => goToNoticedTab(windowId, shown)))} accessibilityRole="button" accessibilityLabel="New tab opened. Go to the new tab." style={POINTER}>
            {({ pressed }) => (
              <View style={{ opacity: pressed ? NEW_TAB_NOTICE.pressedOpacity : 1 }}>
                <Hud shape="capsule" height={NEW_TAB_NOTICE.height}>
                  <View style={[ROW, { backgroundColor: hover ? windowColors(theme.dark).noticeHover : undefined }]}>
                    <Symbol name="plus.square.on.square" size={12} weight="semibold" color={theme.icon} style={ICON} />
                    <Text size="small" weight="semibold" numberOfLines={1} ardiaCentersCapitals>
                      New tab opened
                    </Text>
                    <Symbol name="arrow.right" size={10} weight="semibold" color={hover ? theme.textPrimary : theme.textSecondary} style={ICON} />
                  </View>
                </Hud>
              </View>
            )}
          </Pressable>
        </View>
      </ClosingView>
    </View>
  );
}

const ICON = { width: 14, height: 14 } as const;
const ROW = { height: NEW_TAB_NOTICE.height, borderRadius: capsule(NEW_TAB_NOTICE.height), flexDirection: "row", alignItems: "center", gap: space.s, paddingHorizontal: space.l } as const;
const POINTER = { cursor: "pointer" } as const;
