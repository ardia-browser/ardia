import { memo, type ReactNode } from "react";
import { Pressable, View, type GestureResponderEvent } from "react-native";
import type { LibraryItemKind } from "../../state/sidebar/sidebarUi";
import { ContextMenuArea, HoverSlot, MouseArea, Text, useTheme } from "../ui";
import { useLibraryItemHover } from "./useLibraryItemHover";
import { accessibilityActionsOf, runAccessibilityAction, type LibraryItemAction } from "./itemActions";
import { LIBRARY } from "./tokens";

const L = LIBRARY.list;
const FRAME = { height: L.row, paddingHorizontal: L.inset } as const;
const TEXT = { flex: 1, justifyContent: "center" } as const;
const FILL = { flex: 1 } as const;
const ICON_BOX = { width: L.fileIcon, alignItems: "center", justifyContent: "center" } as const;

export const LibraryRow = memo(function LibraryRow({
  windowId,
  card,
  icon,
  title,
  subtitle,
  label,
  highlighted,
  muted,
  truncate = "tail",
  path,
  trailing,
  badge,
  onPress,
  onMiddleClick,
  onContextMenu,
  actions,
}: {
  windowId: string;
  card: { kind: LibraryItemKind; id: string };
  icon: ReactNode;
  title: string;
  subtitle: ReactNode;
  label: string;
  highlighted: boolean;
  muted?: boolean;
  truncate?: "tail" | "middle";
  path?: string | null;
  trailing?: { width: number; node: ReactNode; always?: boolean };
  badge?: ReactNode;
  onPress: (e: GestureResponderEvent) => void;
  onMiddleClick?: () => void;
  onContextMenu: () => void;
  actions?: readonly LibraryItemAction[];
}) {
  const theme = useTheme();
  const { hovered, hoverProps, anchorRef } = useLibraryItemHover(windowId, card.kind, card.id);
  return (
    <View ref={anchorRef} {...hoverProps} style={FRAME}>
      <MouseArea path={path ?? null} onMiddleClick={onMiddleClick} style={FILL}>
        <ContextMenuArea onContextMenu={onContextMenu} style={FILL}>
          <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityActions={accessibilityActionsOf(actions)}
            onAccessibilityAction={(e) => runAccessibilityAction(e.nativeEvent.actionName, actions, onContextMenu)}
            style={FILL}
          >
            {({ pressed }) => (
              <View
                style={{
                  flex: 1,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: L.iconGap,
                  paddingHorizontal: L.rowPad,
                  borderRadius: L.radius,
                  backgroundColor: pressed ? theme.tabPressed : hovered || highlighted ? theme.tabHover : undefined,
                }}
              >
                <View style={ICON_BOX}>
                  {icon}
                  {badge}
                </View>
                <View style={TEXT}>
                  <Text lines={1} ellipsizeMode={truncate} tone={muted ? "textSecondary" : "textPrimary"}>
                    {title}
                  </Text>
                  {subtitle}
                </View>
                {trailing ? <HoverSlot hovered={hovered || highlighted || !!trailing.always} width={trailing.width} reserve="hover" hover={trailing.node} /> : null}
              </View>
            )}
          </Pressable>
        </ContextMenuArea>
      </MouseArea>
    </View>
  );
});

export const RowSubtitle = memo(function RowSubtitle({ text, tone = "textSecondary" }: { text: string; tone?: "textSecondary" | "destructive" }) {
  return (
    <Text lines={1} size="caption" tone={tone}>
      {text}
    </Text>
  );
});
