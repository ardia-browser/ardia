import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useWindowId } from "../../state/browser/hooks";
import { closePluginCommandView, closePluginPopover } from "../../state/plugins/actions";
import { usePluginCommandView, usePluginInputBox, usePluginPopover, usePluginQuickPick, usePluginWindowEligible } from "../../state/plugins/hooks";
import type { CommandView, Popover as PluginPopoverState } from "../../state/plugins/surfaces";
import { Box, Button, Dialog, Divider, Popover, POPOVER_MARGIN, Symbol, Text, useTheme } from "../ui";
import { PluginInputBox } from "./PluginInputBox";
import { PluginQuickPick } from "./PluginQuickPick";
import { PluginSurface } from "./PluginSurface";
import type { SurfaceKeys } from "./surfaceShortcuts";
import { OVERLAY } from "./tokens";

export function PluginOverlays() {
  const windowId = useWindowId();
  const eligible = usePluginWindowEligible(windowId);
  const quickPick = usePluginQuickPick();
  const inputBox = usePluginInputBox();
  const commandView = usePluginCommandView(windowId);
  const popover = usePluginPopover(windowId);
  if (!eligible) return null;
  return (
    <>
      {popover ? <ToolbarPopover key={`${popover.plugin}:${popover.itemId}:${popover.viewId}`} windowId={windowId} popover={popover} /> : null}
      {commandView ? <CommandSheet key={`${commandView.plugin}:${commandView.viewId}`} windowId={windowId} view={commandView} /> : null}
      {quickPick?.windowId === windowId ? <PluginQuickPick key={quickPick.id} request={quickPick} /> : null}
      {inputBox?.windowId === windowId ? <PluginInputBox key={inputBox.id} request={inputBox} /> : null}
    </>
  );
}

function CommandSheet({ windowId, view }: { windowId: string; view: CommandView }) {
  const theme = useTheme();
  const close = () => closePluginCommandView(windowId);
  const keys = useRef<View>(null);
  useEffect(() => keys.current?.focus(), []);
  const [surfaceKeys, setSurfaceKeys] = useState<SurfaceKeys | null>(null);
  const keyDownEvents = useMemo(() => (surfaceKeys ? [...ESCAPE_KEY, ...surfaceKeys.keys] : ESCAPE_KEY), [surfaceKeys]);
  return (
    <Dialog width="l" pad="none" animated maxHeight={OVERLAY.commandHeight} onDismiss={close}>
      <View
        ref={keys}
        focusable
        enableFocusRing={false}
        keyDownEvents={keyDownEvents}
        onKeyDown={(e) => {
          if (e.nativeEvent.key === "Escape") close();
          else surfaceKeys?.press(e.nativeEvent);
        }}
      >
      <Box row gap="m" padX="l" padY="m" style={HEADER}>
        <Symbol name={view.icon || "puzzlepiece"} size={OVERLAY.commandIcon} color={theme.icon} style={ICON} />
        <Text weight="semibold" numberOfLines={1} style={FLEX}>
          {view.title}
        </Text>
        <Button variant="close" look="panel" tooltip="Close" onPress={close} />
      </Box>
      <Divider />
      <ScrollView style={BODY} contentContainerStyle={BODY_CONTENT}>
        <PluginSurface plugin={view.plugin} surfaceId={view.viewId} viewId={view.viewId} kind="command" windowId={windowId} context={{ command: view.command }} onKeys={setSurfaceKeys} />
      </ScrollView>
      </View>
    </Dialog>
  );
}

function ToolbarPopover({ windowId, popover }: { windowId: string; popover: PluginPopoverState }) {
  const [closing, setClosing] = useState(false);
  const [room, setRoom] = useState<number | null>(null);
  const { anchor } = popover;
  const width = OVERLAY.popoverWidth;
  const right = room === null ? null : Math.max(POPOVER_MARGIN, room - (anchor.x + anchor.width));
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill} onLayout={(e) => setRoom(e.nativeEvent.layout.width)}>
      {right === null ? null : (
        <Popover width={width} top={anchor.y + anchor.height + OVERLAY.popoverGap} right={right} fitHeight closing={closing} onClosed={() => closePluginPopover(windowId)} onDismiss={() => setClosing(true)}>
          <View style={POPOVER_BODY}>
            <PluginSurface plugin={popover.plugin} surfaceId={popover.viewId} viewId={popover.viewId} kind="popover" windowId={windowId} context={{ itemId: popover.itemId }} />
          </View>
        </Popover>
      )}
    </View>
  );
}

const ESCAPE_KEY = [{ key: "Escape" }];
const FLEX = { flex: 1 } as const;
const HEADER = { alignItems: "center" } as const;
const ICON = { width: OVERLAY.commandIcon + POPOVER_MARGIN / 2, height: OVERLAY.commandIcon + POPOVER_MARGIN / 2 } as const;
const BODY = { maxHeight: OVERLAY.commandHeight } as const;
const BODY_CONTENT = { padding: POPOVER_MARGIN } as const;
const POPOVER_BODY = { maxHeight: OVERLAY.popoverMaxHeight } as const;
