import { useRef, useState } from "react";
import { View } from "react-native";
import { useSettings } from "../../../state/browser/hooks";
import { updateSettings } from "../../../state/settings/actions";
import { TOOLBAR_ACTIONS, type ToolbarAction } from "../../../state/settings/toolbarActions";
import { Box, Button, Divider, space, Symbol, Text, Toggle, useTheme } from "../../ui";
import { Row } from "../Form";

const LABELS = { bookmark: "Bookmark", copyUrl: "Copy URL" };
const ICONS = { bookmark: "bookmark", copyUrl: "link" };
const ROW_HEIGHT = 40;

export function ToolbarActionEditor() {
  const saved = useSettings((s) => s.toolbarActions);
  const bookmarks = useSettings((s) => s.showBookmarks);
  const theme = useTheme();
  const pinned = saved ?? [];
  const available = TOOLBAR_ACTIONS.filter((action) => bookmarks || action !== "bookmark");
  const shown = pinned.filter((action) => available.includes(action));
  const actions = [...shown, ...available.filter((action) => !shown.includes(action))];
  const [drag, setDrag] = useState<{ action: ToolbarAction; dy: number } | null>(null);
  const startY = useRef(0);
  const position = (from: number, dy: number) => Math.max(0, Math.min(shown.length - 1, from + Math.round(dy / ROW_HEIGHT)));
  const from = drag ? shown.indexOf(drag.action) : -1;
  const to = drag ? position(from, drag.dy) : -1;
  const move = (action: ToolbarAction, target: number) => {
    if (target < 0 || target >= shown.length || shown[target] === action) return;
    const reordered = pinned.filter((item) => item !== action);
    reordered.splice(pinned.indexOf(shown[target]!), 0, action);
    updateSettings({ toolbarActions: reordered });
  };
  return (
    <Box fill="groupFill" border="groupBorder" radius="panel">
      <Row anchor="appearance.toolbarActions">
        {saved !== null && <Button title="Restore Default" onPress={() => updateSettings({ toolbarActions: null })} />}
      </Row>
      <Divider thick inset="l" />
      {actions.map((action, index) => {
        const name = LABELS[action];
        const on = shown.includes(action);
        const lifted = drag?.action === action;
        const shift = lifted ? Math.max(-from * ROW_HEIGHT, Math.min((shown.length - 1 - from) * ROW_HEIGHT, drag.dy))
          : from < index && index <= to ? -ROW_HEIGHT : to <= index && index < from ? ROW_HEIGHT : 0;
        return (
          <Box key={action} row gap="m" padX="l"
            style={{ alignItems: "center", height: ROW_HEIGHT, zIndex: lifted ? 1 : 0, transform: [{ translateY: shift }], backgroundColor: lifted ? theme.panel : undefined }}
          >
            <Symbol name={ICONS[action]} size={14} color={theme.icon} style={{ width: 20, height: 20 }} />
            <Text style={{ flex: 1 }}>{name}</Text>
            {on && shown.length > 1 && (
              <View
                accessible
                accessibilityRole="adjustable"
                accessibilityLabel={`Position of ${name}`}
                accessibilityValue={{ min: 1, now: index + 1, max: shown.length }}
                accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
                onAccessibilityAction={(e) => move(action, index + (e.nativeEvent.actionName === "increment" ? 1 : -1))}
                tooltip={`Drag to reorder ${name}`}
                style={{ padding: space.xs }}
                onStartShouldSetResponder={() => true}
                onResponderGrant={(e) => {
                  startY.current = e.nativeEvent.pageY;
                  setDrag({ action, dy: 0 });
                }}
                onResponderMove={(e) => setDrag({ action, dy: e.nativeEvent.pageY - startY.current })}
                onResponderRelease={(e) => {
                  move(action, position(index, e.nativeEvent.pageY - startY.current));
                  setDrag(null);
                }}
                onResponderTerminationRequest={() => false}
                onResponderTerminate={() => setDrag(null)}
              >
                <Symbol name="line.3.horizontal" size={12} color={theme.textSecondary} style={{ width: 20, height: 20 }} />
              </View>
            )}
            <Toggle value={on} accessibilityLabel={`Pin ${name} in the address bar`} onChange={(enable) => updateSettings({ toolbarActions: enable ? [...pinned, action] : pinned.filter((item) => item !== action) })} />
          </Box>
        );
      })}
    </Box>
  );
}
