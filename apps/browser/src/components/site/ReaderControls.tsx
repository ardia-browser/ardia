import { memo } from "react";
import { stepReaderSize, toggleReader, toggleReaderFont, useReader, useReaderState } from "../../state/reader/reader";
import { useSettings } from "../../state/browser/hooks";
import { READER_SIZE_NAMES } from "../../state/reader/tokens";
import { useShortcutHint, withShortcut } from "../../state/commands/commandShortcuts";
import { Box, Button, MenuRow } from "../ui";
import { useTheme } from "../ui/theme";
import type { ToolbarPalette } from "../ui/toolbarColors";

export const readerButtonShown = (state: { active: boolean; available: boolean } | undefined, quiet: boolean) => !!state && (state.active || (state.available && !quiet));

export const useReaderButtonShown = (tabId: string, quiet: boolean) => useReader((s) => readerButtonShown(s[tabId], quiet));

export const ReaderButton = memo(function ReaderButton({ tabId, palette, onFocus, quiet = false }: { tabId: string; palette: ToolbarPalette; onFocus: () => void; quiet?: boolean }) {
  const theme = useTheme();
  const state = useReaderState(tabId);
  const hint = useShortcutHint("toggleReader");
  if (!state.active && (!state.available || quiet)) return null;
  return (
    <Button variant="icon" toolbar
      palette={palette}
      look="field"
      icon="doc.plaintext"
      color={state.active ? theme.accent : undefined}
      onPress={() => {
        onFocus();
        void toggleReader(tabId);
      }}
      tooltip={withShortcut(state.active ? "Hide Reader" : "Show Reader", hint)}
    />
  );
});

export function ReaderRow({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const state = useReaderState(tabId);
  if (!state.available && !state.active) return null;
  return (
    <MenuRow
      icon="doc.plaintext"
      title={state.active ? "Hide Reader" : "Show Reader"}
      onPress={() => {
        onClose();
        void toggleReader(tabId);
      }}
    />
  );
}

export function ReaderLookRow({ tabId }: { tabId: string }) {
  const state = useReaderState(tabId);
  const size = useSettings((s) => READER_SIZE_NAMES.indexOf(s.readerTextSize));
  const font = useSettings((s) => s.readerFont);
  if (!state.active) return null;
  return (
    <MenuRow
      icon="textformat"
      title="Reader Text"
      accessory={
        <Box row gap="xs" style={CENTER_ROW}>
          <Button variant="stepper" icon="minus" tooltip="Smaller Text" disabled={size === 0} onPress={() => stepReaderSize(-1)} />
          <Button variant="stepper" icon="plus" tooltip="Larger Text" disabled={size === READER_SIZE_NAMES.length - 1} onPress={() => stepReaderSize(1)} />
          <Button variant="pill" title={font === "serif" ? "Sans-Serif" : "Serif"} onPress={toggleReaderFont} />
        </Box>
      }
    />
  );
}

const CENTER_ROW = { alignItems: "center" } as const;
