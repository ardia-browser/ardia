import { memo } from "react";
import { toggleReader, useReaderState } from "../../state/reader/reader";
import { useShortcutHint, withShortcut } from "../../state/commands/commandShortcuts";
import { Button, MenuRow } from "../ui";
import { useTheme } from "../ui/theme";
import type { ToolbarPalette } from "../ui/toolbarColors";

export const ReaderButton = memo(function ReaderButton({ tabId, palette, onFocus }: { tabId: string; palette: ToolbarPalette; onFocus: () => void }) {
  const theme = useTheme();
  const state = useReaderState(tabId);
  const hint = useShortcutHint("toggleReader");
  if (!state.available && !state.active) return null;
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
