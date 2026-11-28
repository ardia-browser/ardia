import { useRef } from "react";
import { Animated, View } from "react-native";
import { Button, capsule, space, useTheme, usePresence } from "../ui";
import { toolbarPalette } from "../ui/toolbarColors";
import { HudPlate } from "../window/Hud";
import { paneHandleVisible, type PaneHandleDrag } from "../window/paneChrome";
import { pressClosePane } from "../../state/splits/actions";
import { useTabDrag } from "../../state/drag/tabDrag";
import { noteSplit } from "../../state/telemetry/usage";
import { PaneSplitButton } from "./PaneSplitButton";
import { PANE_HANDLE, SPLIT_MOTION } from "./tokens";

export function PaneHandle({ tabId, hovered, always }: { tabId: string; hovered: boolean; always: boolean }) {
  const theme = useTheme();
  const palette = toolbarPalette(theme, null);
  const drag = useTabDrag((s): PaneHandleDrag => (s.phase === "tab" ? (s.tabId === tabId ? "own" : "other") : s.phase === "external" ? "other" : null));
  const wasVisible = useRef(false);
  const visible = paneHandleVisible({ always, hovered, drag, wasVisible: wasVisible.current });
  wasVisible.current = visible;
  const { shown: mounted, appear } = usePresence(visible || null, SPLIT_MOTION.paneHandle);
  if (!mounted) return null;
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, top: PANE_HANDLE.top, alignItems: "center" }}>
      <Animated.View pointerEvents={visible ? "auto" : "none"} style={{ opacity: appear }}>
        <HudPlate shape="capsule" height={PANE_HANDLE.height}>
          <View style={{ height: PANE_HANDLE.height, flexDirection: "row", alignItems: "center", paddingHorizontal: space.xxs }}>
            <PaneSplitButton tabId={tabId} palette={palette} box={PANE_HANDLE.button} radius={capsule(PANE_HANDLE.button)} onUse={() => noteSplit("splitPaneHandleUses")} />
            <Button variant="icon" toolbar palette={palette} icon="xmark" look="row" box={PANE_HANDLE.button} radius={capsule(PANE_HANDLE.button)} weight="medium" onPress={() => pressClosePane(tabId)} tooltip="Close Pane" />
          </View>
        </HudPlate>
      </Animated.View>
    </View>
  );
}
