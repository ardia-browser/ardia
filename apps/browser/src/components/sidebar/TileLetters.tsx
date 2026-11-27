import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Button, Panel, radius, space, Text, TextField } from "../ui";
import { useTheme } from "../ui/theme";
import { useTab } from "../../state/browser/hooks";
import { useSidebarUi } from "../../state/sidebar/sidebarUi";
import { closeTileLetters, commitTileLetters } from "../../state/pins/tileLetters";
import { cleanTileLetters, tileLetterOf, TILE_LETTERS_MAX } from "../../lib/tileLetter";
import { consentToken } from "../../state/telemetry/choice";
import { ICON_PICKER, ICON_PICKER_SHADOW } from "../iconPicker/tokens";

export const TILE_LETTERS_WIDTH = 236;

type Target = NonNullable<ReturnType<typeof useSidebarUi.getState>["tileLetters"]>;
type Room = { width: number; height: number };

export function TileLetters({ windowId }: { windowId: string }) {
  const target = useSidebarUi((u) => (u.tileLetters?.windowId === windowId ? u.tileLetters : null));
  return target ? <TileLettersPanel key={target.tabId} target={target} /> : null;
}

export function placeTileLetters(anchor: Target["anchor"], room: Room, height: number) {
  const { anchorGap, windowMargin } = ICON_PICKER;
  const box = anchor ?? { x: room.width / 2, y: windowMargin, width: 0, height: 0 };
  const left = Math.max(windowMargin, Math.min(box.x + box.width / 2 - TILE_LETTERS_WIDTH / 2, room.width - windowMargin - TILE_LETTERS_WIDTH));
  const below = box.y + box.height + anchorGap;
  const above = box.y - anchorGap - height;
  const preferred = below + height > room.height - windowMargin && above >= windowMargin ? above : below;
  const top = Math.max(windowMargin, Math.min(preferred, room.height - windowMargin - height));
  return { top, left };
}

export const lettersHint = (draft: string, siteLetter: string) => {
  const shown = draft.trim() ? cleanTileLetters(draft) : null;
  return shown ? `The tile shows “${shown}”.` : `Up to ${TILE_LETTERS_MAX}. Leave it empty for the site’s letter${siteLetter ? `, “${siteLetter}”` : ""}.`;
};

export function TileLettersPanel({ target }: { target: Target }) {
  const theme = useTheme();
  const own = useTab(target.tabId, (t) => t?.tileLetters ?? "");
  const siteLetter = useTab(target.tabId, (t) => (t ? tileLetterOf(t.url, t.customTitle ?? t.title) : ""));
  const [draft, setDraft] = useState(own);
  const [room, setRoom] = useState<Room | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const done = () => commitTileLetters(target.tabId, draft, consentToken());
  const place = room ? placeTileLetters(target.anchor, room, height ?? 0) : null;
  return (
    <>
      <Pressable accessibilityLabel="Cancel" onPress={closeTileLetters} style={StyleSheet.absoluteFill} onLayout={(e) => setRoom({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })} />
      {place ? (
        <View onLayout={(e) => setHeight(e.nativeEvent.layout.height)} style={{ position: "absolute", top: place.top, left: place.left, width: TILE_LETTERS_WIDTH, opacity: height === null ? 0 : 1 }}>
          <Panel fill={theme.panel} radius={radius.sheet} border={theme.panelBorder} shadow={ICON_PICKER_SHADOW} style={PANEL}>
            <Text size="small" weight="semibold">
              Tile Letters
            </Text>
            <TextField autoFocus selectOnFocus value={draft} onChangeText={setDraft} placeholder={siteLetter} onSubmit={done} onEscape={closeTileLetters} />
            <Text size="caption" tone="textTertiary">
              {lettersHint(draft, siteLetter)}
            </Text>
            <View style={BUTTONS}>
              <Button variant="pill" tone="chip" title="Cancel" onPress={closeTileLetters} />
              <Button variant="pill" tone="chip" primary title="Done" onPress={done} />
            </View>
          </Panel>
        </View>
      ) : null}
    </>
  );
}

const PANEL = { padding: ICON_PICKER.pad, gap: space.m } as const;
const BUTTONS = { flexDirection: "row", justifyContent: "flex-end", gap: space.s } as const;
