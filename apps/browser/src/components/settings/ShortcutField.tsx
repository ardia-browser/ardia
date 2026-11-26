import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { cancelShortcutRecording, recordShortcut, resolvedShortcuts, useMenuBarRevision, type MenuShortcut } from "../../state/commands/commandShortcuts";
import { conflictMessage, conflictTitles } from "../../state/commands/shortcutConflicts";
import { shortcutRecorder, type ShortcutRecorder } from "../../state/commands/shortcutRecorder";
import { formatShortcut, type ResolvedShortcuts, type Shortcut } from "../../state/commands/shortcuts";
import { useSettings } from "../../state/browser/hooks";
import { useProfileOrder } from "../../state/profiles/hooks";
import { applyRecordedShortcut, clearShortcut, NO_SHORTCUT, type RecordedChange } from "../../state/settings/recordedShortcut";
import { setMouseShortcut } from "../../state/settings/actions";
import { shortcutItems } from "../../state/settings/paneData";
import { useResource } from "../../state/settings/resources";
import { KeyCap, space, Symbol, Text, useHover } from "../ui";
import { useTheme } from "../ui/theme";

export function useResolvedShortcuts(items: readonly MenuShortcut[] | null | undefined): ResolvedShortcuts {
  const overrides = useSettings((s) => s.shortcuts);
  const mouseOverrides = useSettings((s) => s.mouseShortcuts);
  const profileOrder = useProfileOrder();
  const menuBar = useMenuBarRevision();
  return useMemo(() => resolvedShortcuts({ settings: { shortcuts: overrides, mouseShortcuts: mouseOverrides }, profileOrder }), [items, overrides, mouseOverrides, profileOrder, menuBar]);
}

export function useCommandConflicts(command: string): string[] {
  const [items] = useResource(shortcutItems);
  const resolved = useResolvedShortcuts(items);
  return useMemo(() => (items ? conflictTitles(resolved, items, command) : []), [items, resolved, command]);
}

export function ShortcutConflict({ titles }: { titles: readonly string[] }) {
  return (
    <Text size="caption" tone="warning" style={CONFLICT}>
      {conflictMessage(titles)}
    </Text>
  );
}

export function CommandKeyField({ command, onChange }: { command: string; onChange?: (change: RecordedChange) => void }) {
  const [items] = useResource(shortcutItems);
  const resolved = useResolvedShortcuts(items);
  const [recording, setRecording] = useState(false);
  const recorder = useRef<ShortcutRecorder | null>(null);
  recorder.current ??= shortcutRecorder(recordShortcut, cancelShortcutRecording);
  useEffect(() => () => recorder.current?.stop(), []);
  const item = items?.find((i) => i.id === command);
  if (!item) return null;
  const record = async () => {
    const session = recorder.current;
    if (!session || session.recording) return;
    setRecording(true);
    const combo = await session.take().catch(() => null);
    if (combo === undefined) return;
    setRecording(false);
    const change = applyRecordedShortcut(item, combo);
    if (change) onChange?.(change);
  };
  return (
    <ShortcutField
      combo={resolved.bindings.get(command)?.[0] ?? NO_SHORTCUT}
      mouse={resolved.mouse.get(command)}
      remappable={item.remappable}
      recording={recording}
      tooltip="Change Shortcut"
      onRecord={() => void record()}
      onClear={() => {
        const change = clearShortcut(item);
        if (change) onChange?.(change);
      }}
      onClearMouse={() => setMouseShortcut(command, null)}
    />
  );
}

type ShortcutFieldProps = { combo: Shortcut; mouse?: Shortcut; remappable: boolean; recording: boolean; tooltip?: string; onRecord: () => void; onClear: () => void; onClearMouse: () => void };

export function ShortcutField({ mouse, onClearMouse, ...keys }: ShortcutFieldProps) {
  if (!mouse) return <KeyField {...keys} />;
  return (
    <View style={FIELDS}>
      <KeyField {...keys} />
      <MouseField button={mouse} onClear={onClearMouse} />
    </View>
  );
}

function useShownClear() {
  const { hovered, hoverProps } = useHover();
  const [focused, setFocused] = useState(0);
  const focus = { onFocus: () => setFocused((n) => n + 1), onBlur: () => setFocused((n) => Math.max(0, n - 1)) };
  return { hovered, hoverProps, focus, shown: hovered || focused > 0 };
}

function ClearButton({ shown, label, onPress, focus }: { shown: boolean; label: string; onPress: () => void; focus: { onFocus: () => void; onBlur: () => void } }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      tooltip={label}
      focusable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...focus}
      pointerEvents={shown ? "auto" : "none"}
      style={[CLEAR, shown ? null : HIDDEN]}
    >
      <Symbol name="xmark.circle.fill" size={11} color={theme.textTertiary} style={CLEAR_GLYPH} />
    </Pressable>
  );
}

function MouseField({ button, onClear }: { button: Shortcut; onClear: () => void }) {
  const { hovered, hoverProps, focus, shown } = useShownClear();
  return (
    <View {...hoverProps} style={KEY_FIELD}>
      <KeyCap keys={[formatShortcut(button)]} hovered={hovered} />
      <ClearButton shown={shown} label="Remove Mouse Shortcut" onPress={onClear} focus={focus} />
    </View>
  );
}

function KeyField({ combo, remappable, recording, tooltip, onRecord, onClear }: Omit<ShortcutFieldProps, "mouse" | "onClearMouse">) {
  const { hovered, hoverProps, focus, shown } = useShownClear();
  const text = recording ? "Type Shortcut" : formatShortcut(combo);
  if (!remappable) {
    return (
      <View style={FIXED_KEYS} tooltip="(not remappable)">
        <Text tone="textTertiary">{text || "—"}</Text>
      </View>
    );
  }
  return (
    <View {...hoverProps} style={KEY_FIELD}>
      <Pressable
        onPress={onRecord}
        tooltip={recording ? undefined : tooltip}
        focusable
        accessibilityRole="button"
        accessibilityLabel={text ? `Shortcut ${text}` : "No shortcut"}
        accessibilityHint={tooltip}
        {...focus}
      >
        <KeyCap keys={[text || "None"]} editing={recording} empty={!text} hovered={hovered} />
      </Pressable>
      {!recording && combo.key ? <ClearButton shown={shown} label="Remove Shortcut" onPress={onClear} focus={focus} /> : null}
    </View>
  );
}

const FIXED_KEYS = { minWidth: 110, alignItems: "flex-end" } as const;
const FIELDS = { flexDirection: "row", alignItems: "center", gap: space.s } as const;
const KEY_FIELD = { minWidth: 110, justifyContent: "center" } as const;
const CLEAR = { position: "absolute", right: space.xs } as const;
const CLEAR_GLYPH = { width: 14, height: 14 } as const;
const HIDDEN = { opacity: 0 } as const;
const CONFLICT = { marginTop: space.xxs } as const;
