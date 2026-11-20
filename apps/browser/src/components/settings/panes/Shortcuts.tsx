import { cancelShortcutRecording, recordShortcut, type MenuShortcut, resolvedShortcuts, useMenuBarRevision } from "../../../state/commands/commandShortcuts";
import { Box, Button, EmptyState, KeyCap, PopUp, SearchField, space, Symbol, Text, Toggle, useHover, type Option } from "../../ui";
import { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useTheme } from "../../ui/theme";
import { useSettings } from "../../../state/browser/hooks";
import { useSpaceOrder } from "../../../state/spaces/hooks";
import { setShortcutOverride, updateSettings } from "../../../state/settings/actions";
import { openUrls } from "../../../state/browser/actions";
import { Anchor, Group, Row, SectionHeader, SettingToggle } from "../Form";
import { setting, type SettingId } from "../settingsIndex";
import { matchesQuery } from "../../pages/PageLayout";
import { shortcutItems } from "../../../state/settings/paneData";
import { useResource } from "../../../state/settings/resources";
import { formatShortcut, sameShortcut, type Shortcut } from "../../../state/commands/shortcuts";
import { splitLinkModifierOf, type PeekModifier, type SplitLinkModifier } from "../../../state/settings/settings";
import { keyText } from "../../../state/commands/keyText";
import type { SettingsPlace } from "../../../state/settings/settingsWindows";

type Filter = "all" | "customized" | "conflicts";

const NO_SHORTCUT: Shortcut = { key: "", modifiers: [] };
const EXTENSION_ITEM = "openExtension:";

const FILTERS: Option<Filter>[] = [
  { value: "all", title: "All Shortcuts" },
  { value: "customized", title: "Customized Shortcuts" },
  { value: "conflicts", title: "Conflicting Shortcuts" },
];

const PEEK_WITH: Option<PeekModifier>[] = [
  { value: "shift", title: `${keyText("⇧")}-click` },
  { value: "alt", title: `${keyText("⌥")}-click` },
  { value: "off", title: "Off" },
];

const SPLIT_WITH: Option<SplitLinkModifier>[] = [
  { value: "altShift", title: `${keyText("⌥⇧")}-click` },
  { value: "alt", title: `${keyText("⌥")}-click` },
];

const withNote = (anchor: SettingId, note: string | null) => (note ? `${setting(anchor).description ?? ""} ${note}`.trim() : undefined);

export function ShortcutsPane(_place: SettingsPlace) {
  return (
    <View>
      <KeyboardSection />
      <ClicksSection />
    </View>
  );
}

function KeyboardSection() {
  const overrides = useSettings((s) => s.shortcuts);
  const spaceOrder = useSpaceOrder();
  const menuBar = useMenuBarRevision();
  const [loaded] = useResource(shortcutItems);
  const items = loaded ?? null;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [recording, setRecording] = useState<string | null>(null);

  useEffect(() => () => void cancelShortcutRecording(), []);

  const resolved = useMemo(() => resolvedShortcuts({ settings: { shortcuts: overrides }, spaceOrder }), [items, overrides, spaceOrder, menuBar]);
  const byId = useMemo(() => new Map((items ?? []).map((item) => [item.id, item])), [items]);
  const effective = (item: MenuShortcut): Shortcut => resolved.bindings.get(item.id)?.[0] ?? NO_SHORTCUT;
  const conflictsOf = (item: MenuShortcut) => resolved.conflictsOf(item.id).flatMap((id) => byId.get(id) ?? []);

  const record = async (item: MenuShortcut) => {
    setRecording(item.id);
    const combo = await recordShortcut();
    setRecording(null);
    if (!combo) return;
    const isDefault = sameShortcut(combo, resolved.defaultsOf(item.id)[0] ?? NO_SHORTCUT);
    setShortcutOverride(item.id, isDefault ? null : combo);
  };

  const shown = (items ?? []).filter((item) => {
    if (!matchesQuery(query, item.title, item.path.join(" "), formatShortcut(effective(item)))) return false;
    if (filter === "customized") return !!overrides[item.id];
    if (filter === "conflicts") return conflictsOf(item).length > 0;
    return true;
  });
  const menuItems = shown.filter((i) => !i.id.startsWith(EXTENSION_ITEM));
  const extensionItems = shown.filter((i) => i.id.startsWith(EXTENSION_ITEM));
  const menus = [...new Set(menuItems.map((i) => i.path[0] ?? ""))];
  const customizedCount = Object.keys(overrides).length;

  const itemRow = (item: MenuShortcut) => {
    const others = conflictsOf(item);
    return (
      <Row
        key={item.id}
        icon={null}
        title={item.title}
        description={
          others.length ? (
            <Text size="caption" tone="warning" style={CONFLICT}>
              {`${others.length === 1 ? "This shortcut conflicts with another shortcut:" : "This shortcut conflicts with other shortcuts:"} ${others.map((o) => o.title).join(", ")}`}
            </Text>
          ) : item.path.length > 1 ? (
            item.path.slice(1).join(" › ")
          ) : undefined
        }
      >
        {overrides[item.id] && <Button variant="icon" icon="arrow.uturn.backward" size="m" onPress={() => setShortcutOverride(item.id, null)} tooltip="Reset to Default" />}
        <ShortcutField
          combo={effective(item)}
          remappable={item.remappable}
          recording={recording === item.id}
          onRecord={() => void record(item)}
          onClear={() => setShortcutOverride(item.id, resolved.defaultsOf(item.id).length ? NO_SHORTCUT : null)}
        />
      </Row>
    );
  };

  return (
    <>
      <SectionHeader title="Keyboard" />
      <Box gap="xl">
        <Group>
          <SettingToggle anchor="shortcuts.undoReopensClosedTab" />
        </Group>
        <Anchor id="shortcuts.menuCommands" shape="row" style={TOOLBAR}>
          <View style={FILL}>
            <SearchField value={query} onChangeText={setQuery} placeholder="Search menu commands" />
          </View>
          <PopUp value={filter} options={FILTERS} onChange={setFilter} minWidth={170} />
          <Button title="Reset All Shortcuts" disabled={!customizedCount} onPress={() => updateSettings({ shortcuts: {} })} />
        </Anchor>
      </Box>
      {items !== null && menuItems.length === 0 && (
        <View style={NO_MATCH}>
          <EmptyState symbol="magnifyingglass" title="No matching commands" />
        </View>
      )}
      {menus.map((menu) => (
        <View key={menu}>
          <SectionHeader title={menu} />
          <Group>{menuItems.filter((i) => (i.path[0] ?? "") === menu).map(itemRow)}</Group>
        </View>
      ))}
      <View style={EXTENSIONS}>
        <Group>
          <Row anchor="shortcuts.extensionShortcuts">
            <Button title="Edit…" onPress={() => openUrls(["chrome://extensions/shortcuts"])} />
          </Row>
          {extensionItems.map(itemRow)}
        </Group>
      </View>
    </>
  );
}

function ClicksSection() {
  const peekWith = useSettings((s) => s.peekModifier);
  const splitWith = useSettings(splitLinkModifierOf);
  const peekOptions = PEEK_WITH.map((o) => (o.value === "alt" && splitWith === "alt" ? { ...o, title: `${keyText("⌥")}-click (split view moves to ${keyText("⌥⇧")}-click)` } : o));
  const splitOptions = SPLIT_WITH.map((o) => (o.value === "alt" && peekWith === "alt" ? { ...o, title: `${keyText("⌥")}-click (Peek moves to ${keyText("⇧")}-click)` } : o));
  return (
    <>
      <SectionHeader title="Clicks" />
      <Group>
        <Row
          anchor="shortcuts.peekModifier"
          description={withNote("shortcuts.peekModifier", splitWith === "alt" ? `${keyText("⌥")}-click opens a split now: choosing it here moves split view back to ${keyText("⌥⇧")}-click.` : null)}
        >
          <PopUp value={peekWith} options={peekOptions} onChange={(peekModifier) => updateSettings({ peekModifier })} />
        </Row>
        <Row
          anchor="shortcuts.splitLinkModifier"
          description={withNote("shortcuts.splitLinkModifier", peekWith === "alt" ? `${keyText("⌥")}-click peeks now: choosing it here moves Peek back to ${keyText("⇧")}-click.` : null)}
        >
          <PopUp value={splitWith} options={splitOptions} onChange={(splitLinkModifier) => updateSettings({ splitLinkModifier })} />
        </Row>
        <SettingToggle anchor="shortcuts.cmdClickCreatesTabGroup" />
        <SettingToggle anchor="shortcuts.optShiftClickOpensInGroup" />
      </Group>
    </>
  );
}

function ShortcutField({ combo, remappable, recording, onRecord, onClear }: { combo: Shortcut; remappable: boolean; recording: boolean; onRecord: () => void; onClear: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
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
      <Pressable onPress={onRecord}>
        <KeyCap keys={[text || "None"]} editing={recording} empty={!text} hovered={hovered} />
      </Pressable>
      {hovered && !recording && combo.key ? (
        <Pressable onPress={onClear} tooltip="Remove Shortcut" style={CLEAR}>
          <Symbol name="xmark.circle.fill" size={11} color={theme.textTertiary} style={{ width: 14, height: 14 }} />
        </Pressable>
      ) : null}
    </View>
  );
}

const TOOLBAR = { flexDirection: "row", alignItems: "center", gap: space.m } as const;
const FILL = { flex: 1 } as const;
const NO_MATCH = { marginTop: space.huge } as const;
const EXTENSIONS = { marginTop: space.xxxl } as const;
const CONFLICT = { marginTop: space.xxs } as const;
const FIXED_KEYS = { minWidth: 110, alignItems: "flex-end" } as const;
const KEY_FIELD = { minWidth: 110, justifyContent: "center" } as const;
const CLEAR = { position: "absolute", right: space.xs } as const;
