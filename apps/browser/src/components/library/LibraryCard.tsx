import { memo, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import type { LibraryItemKind } from "../../state/sidebar/sidebarUi";
import { ContextMenuArea, MouseArea, Text, useTheme } from "../ui";
import { buttonMotion, usePressScaleMotion } from "../ui/motion";
import { LIBRARY } from "./tokens";
import { useLibraryItemHover } from "./useLibraryItemHover";
import { accessibilityActionsOf, runAccessibilityAction, type LibraryItemAction } from "./itemActions";

const G = LIBRARY.grid;
const C = LIBRARY.card;

export const LibraryCard = memo(function LibraryCard({
  windowId,
  card,
  width,
  faceHeight,
  highlighted,
  label,
  path,
  face,
  title,
  subtitle,
  muted,
  truncate = "tail",
  onPress,
  onMiddleClick,
  onContextMenu,
  corner,
  badge,
  actions,
}: {
  windowId: string;
  card: { kind: LibraryItemKind; id: string };
  width: number;
  faceHeight: number;
  highlighted: boolean;
  label: string;
  path?: string | null;
  face: ReactNode;
  title?: string;
  subtitle?: ReactNode;
  muted?: boolean;
  truncate?: "tail" | "middle";
  onPress: (e: GestureResponderEvent) => void;
  onMiddleClick?: () => void;
  onContextMenu: () => void;
  actions?: readonly LibraryItemAction[];
  corner?: ReactNode;
  badge?: ReactNode;
}) {
  const theme = useTheme();
  const { hovered, hoverProps, anchorRef } = useLibraryItemHover(windowId, card.kind, card.id);
  const press = usePressScaleMotion(true, buttonMotion.controlPressScale);
  return (
    <View ref={anchorRef} {...hoverProps} style={{ width }}>
      <MouseArea path={path ?? null} onMiddleClick={onMiddleClick}>
        <ContextMenuArea onContextMenu={onContextMenu}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityActions={accessibilityActionsOf(actions)}
            onAccessibilityAction={(e) => runAccessibilityAction(e.nativeEvent.actionName, actions, onContextMenu)}
            onPress={onPress}
            onPressIn={press.onPressIn}
            onPressOut={press.onPressOut}
          >
            {({ pressed }) => (
              <Animated.View style={press.scale ? { transform: [{ scale: press.scale }] } : null}>
                <View
                  style={{
                    width,
                    height: faceHeight,
                    padding: G.tileInset,
                    borderRadius: G.radius,
                    overflow: "hidden",
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: pressed ? theme.tabPressed : hovered ? theme.tabHover : theme.pinnedResting,
                    borderWidth: highlighted ? LIBRARY.cards.selectedBorder : StyleSheet.hairlineWidth,
                    borderColor: highlighted ? theme.accent : theme.pinnedRestingStroke,
                  }}
                >
                  {face}
                  {badge}
                </View>
                {title !== undefined ? (
                  <View style={{ paddingTop: C.textAbove, paddingHorizontal: C.textInset }}>
                    <Text lines={1} ellipsizeMode={truncate} tone={muted ? "textSecondary" : "textPrimary"}>
                      {title}
                    </Text>
                    {subtitle}
                  </View>
                ) : null}
              </Animated.View>
            )}
          </Pressable>
        </ContextMenuArea>
      </MouseArea>
      {corner && (hovered || highlighted) ? <View style={CORNER}>{corner}</View> : null}
    </View>
  );
});

const CORNER = { position: "absolute", top: C.cornerInset, right: C.cornerInset } as const;
