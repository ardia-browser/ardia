import { cancelShortcutRecording, recordShortcut, type MenuShortcut, resolvedShortcuts, useCtrlTabChoice, useMenuBarRevision } from "../../../state/commands/commandShortcuts";
import type { CtrlTabChoice } from "../../../state/commands/ctrlTabKeys";
import { Box, Button, EmptyState, KeyCap, PopUp, SearchField, space, Symbol, Text, useHover, type Option } from "../../ui";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useTheme } from "../../ui/theme";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { useSettings } from "../../../state/browser/hooks";
import { useProfileOrder } from "../../../state/profiles/hooks";
import { setMouseShortcut, setShortcutOverride, updateSettings } from "../../../state/settings/actions";
import { openUrls } from "../../../state/browser/actions";
import { Anchor, Group, Row, SectionHeader, SettingToggle } from "../Form";
import { setting, type SettingId } from "../settingsIndex";
import { matchesQuery } from "../../pages/PageLayout";
import { shortcutItems } from "../../../state/settings/paneData";
import { useResource } from "../../../state/settings/resources";
import { comboKey, formatShortcut, isMouseShortcut, sameShortcut, type Shortcut } from "../../../state/commands/shortcuts";
import { splitLinkModifierOf, type PeekModifier, type SplitLinkModifier } from "../../../state/settings/settings";
import { keyText } from "../../../state/commands/keyText";
import type { SettingsPlace } from "../../../state/settings/settingsWindows";
import { jumpToSetting, keySearchConsent, noteShortcutsKeySearch, setShortcutsQuery, useSettingsSearch } from "../../../state/settings/searchState";
import { bindsCombo, parseCombo } from "../../../state/commands/comboQuery";

type Filter = "all" | "customized" | "conflicts";

const NO_SHORTCUT: Shortcut = { key: "", modifiers: [] };
const EXTENSION_ITEM = "openExtension:";
const KEY_SEARCH_SETTLE_MS = 1000;
const KEY_SEARCH_CANCEL_PRESS_MS = 600;
const INITIAL_SHORTCUT_ROWS = 24;
const SHORTCUT_ROW_BATCH = 32;

function useProgressiveCount(total: number, initial: number, step: number): number {
  const [shown, setShown] = useState(() => Math.min(total, initial));
  useEffect(() => {
    if (total <= initial) return setShown(total);
    setShown((current) => Math.min(total, Math.max(current, initial)));
    let cancelled = false;
    let frame = 0;
    const more = () => {
      if (cancelled) return;
      setShown((current) => {
        const next = Math.min(total, current + step);
        if (next < total) frame = requestAnimationFrame(more);
        return next;
      });
    };
    frame = requestAnimationFrame(more);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [total, initial, step]);
  return Math.min(total, shown);
}

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
  const mouseOverrides = useSettings((s) => s.mouseShortcuts);
  const profileOrder = useProfileOrder();
  const menuBar = useMenuBarRevision();
  const [loaded] = useResource(shortcutItems);
  const items = loaded ?? null;
  const query = useSettingsSearch((s) => s.shortcutsQuery);
  const [filter, setFilter] = useState<Filter>("all");
  const [recording, setRecording] = useState<string | null>(null);
  const [keySearching, setKeySearching] = useState(false);
  const recordedQuery = useRef<string | null>(null);
  const keySearchEndedAt = useRef(0);
  const combo = useMemo(() => parseCombo(query), [query]);

  useEffect(() => () => {
    void cancelShortcutRecording();
    setShortcutsQuery("");
  }, []);

  const resolved = useMemo(() => resolvedShortcuts({ settings: { shortcuts: overrides, mouseShortcuts: mouseOverrides }, profileOrder }), [items, overrides, mouseOverrides, profileOrder, menuBar]);
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;
  const byId = useMemo(() => new Map((items ?? []).map((item) => [item.id, item])), [items]);

  const record = useCallback(async (item: MenuShortcut) => {
    setRecording(item.id);
    const combo = await recordShortcut();
    setRecording((current) => (current === item.id ? null : current));
    if (!combo) return;
    if (isMouseShortcut(combo)) return item.remappable && item.mouseBindable ? setMouseShortcut(item.id, combo) : undefined;
    const isDefault = sameShortcut(combo, resolvedRef.current.defaultsOf(item.id)[0] ?? NO_SHORTCUT);
    setShortcutOverride(item.id, isDefault ? null : combo);
  }, []);

  const clear = useCallback((item: MenuShortcut) => {
    setShortcutOverride(item.id, resolvedRef.current.defaultsOf(item.id).length ? NO_SHORTCUT : null);
  }, []);

  const reset = useCallback((id: string) => setShortcutOverride(id, null), []);
  const clearMouse = useCallback((id: string) => setMouseShortcut(id, null), []);

  const searchKeys = async () => {
    if (Date.now() - keySearchEndedAt.current < KEY_SEARCH_CANCEL_PRESS_MS) return;
    setRecording(null);
    setKeySearching(true);
    const pressed = await recordShortcut();
    keySearchEndedAt.current = Date.now();
    setKeySearching(false);
    if (!pressed) return;
    const keys = formatShortcut(pressed);
    recordedQuery.current = keys;
    setShortcutsQuery(keys);
  };

  const { menuItems, extensionItems, found } = useMemo(() => {
    const shown = (items ?? []).filter((item) => {
      const effective = resolved.bindings.get(item.id)?.[0] ?? NO_SHORTCUT;
      const matched = combo
        ? (resolved.bindings.get(item.id) ?? []).some((binding) => bindsCombo(binding, combo))
        : matchesQuery(query, item.title, item.path.join(" "), formatShortcut(effective), formatShortcut(resolved.mouse.get(item.id) ?? NO_SHORTCUT));
      if (!matched) return false;
      if (filter === "customized") return !!overrides[item.id] || resolved.mouse.has(item.id);
      if (filter === "conflicts") return resolved.conflictsOf(item.id).some((id) => byId.has(id));
      return true;
    });
    const menuList: MenuShortcut[] = [];
    const extList: MenuShortcut[] = [];
    for (const item of shown) {
      if (item.id.startsWith(EXTENSION_ITEM)) extList.push(item);
      else menuList.push(item);
    }
    return { menuItems: menuList, extensionItems: extList, found: shown.length > 0 };
  }, [items, query, filter, combo, overrides, resolved, byId]);

  const visibleMenuCount = useProgressiveCount(menuItems.length, INITIAL_SHORTCUT_ROWS, SHORTCUT_ROW_BATCH);
  const sections = useMemo(() => {
    const groups = new Map<string, MenuShortcut[]>();
    const visible = menuItems.slice(0, visibleMenuCount);
    for (const item of visible) {
      const menu = item.path[0] ?? "";
      const list = groups.get(menu);
      if (list) list.push(item);
      else groups.set(menu, [item]);
    }
    return [...groups.entries()].map(([menu, list]) => ({ menu, items: list }));
  }, [menuItems, visibleMenuCount]);

  const customizedCount = Object.keys(overrides).length + resolved.mouse.size;

  useEffect(() => {
    if (!combo || items === null) return;
    const recorded = recordedQuery.current === query;
    const consent = keySearchConsent();
    const timer = setTimeout(() => noteShortcutsKeySearch(recorded ? "recorded" : "typed", found, consent), recorded ? 0 : KEY_SEARCH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [combo && comboKey(combo), items === null]);

  const renderRow = (item: MenuShortcut) => {
    const others = resolved.conflictsOf(item.id).flatMap((id) => byId.get(id) ?? []);
    const conflictText = others.length
      ? `${others.length === 1 ? "This shortcut conflicts with another shortcut:" : "This shortcut conflicts with other shortcuts:"} ${others.map((o) => o.title).join(", ")}`
      : null;
    return (
      <ShortcutRow
        key={item.id}
        item={item}
        combo={resolved.bindings.get(item.id)?.[0] ?? NO_SHORTCUT}
        mouse={resolved.mouse.get(item.id)}
        customized={!!overrides[item.id]}
        conflictText={conflictText}
        recording={recording === item.id}
        onRecord={record}
        onClear={clear}
        onReset={reset}
        onClearMouse={clearMouse}
      />
    );
  };

  return (
    <>
      <SectionHeader title="Keyboard" />
      <Box gap="xl">
        <Group>
          <CtrlTabRow />
          <SettingToggle anchor="shortcuts.undoReopensClosedTab" />
        </Group>
        <Anchor id="shortcuts.menuCommands" shape="row" style={TOOLBAR}>
          <View style={FILL}>
            <SearchField value={keySearching ? "" : query} onChangeText={setShortcutsQuery} placeholder={keySearching ? "Type Shortcut" : "Search menu commands"} />
          </View>
          <Button variant="icon" icon="keyboard" size="m" active={keySearching} tooltip="Search by Keys" onPress={() => (keySearching ? void cancelShortcutRecording() : void searchKeys())} />
          <PopUp value={filter} options={FILTERS} onChange={setFilter} minWidth={170} />
          <Button title="Reset All Shortcuts" disabled={!customizedCount} onPress={() => updateSettings(PLATFORM_FEATURES.mouseShortcuts ? { shortcuts: {}, mouseShortcuts: {} } : { shortcuts: {} })} />
        </Anchor>
        <Text size="caption" tone="textTertiary">
          {PLATFORM_FEATURES.mouseShortcuts ? "To use a mouse button, click a shortcut, then press the middle button or a side button." : "Mouse buttons as shortcuts work on Mac only for now."}
        </Text>
      </Box>
      {items !== null && (combo ? !found : menuItems.length === 0) && (
        <View style={NO_MATCH}>
          <EmptyState symbol={combo ? "keyboard" : "magnifyingglass"} title={combo ? `No command uses ${formatShortcut(combo)}` : "No matching commands"} />
        </View>
      )}
      {sections.map(({ menu, items: sectionItems }) => (
        <View key={menu}>
          <SectionHeader title={menu} />
          <Group>{sectionItems.map(renderRow)}</Group>
        </View>
      ))}
      <View style={EXTENSIONS}>
        <Group>
          <Row anchor="shortcuts.extensionShortcuts">
            <Button title="Edit…" onPress={() => openUrls(["chrome://extensions/shortcuts"])} />
          </Row>
          {extensionItems.map(renderRow)}
        </Group>
      </View>
    </>
  );
}

type ShortcutRowProps = {
  item: MenuShortcut;
  combo: Shortcut;
  mouse?: Shortcut;
  customized: boolean;
  conflictText: string | null;
  recording: boolean;
  onRecord: (item: MenuShortcut) => void;
  onClear: (item: MenuShortcut) => void;
  onReset: (id: string) => void;
  onClearMouse: (id: string) => void;
};

const ShortcutRow = memo(function ShortcutRow({ item, combo, mouse, customized, conflictText, recording, onRecord, onClear, onReset, onClearMouse }: ShortcutRowProps) {
  return (
    <Row
      icon={null}
      title={item.title}
      description={
        conflictText ? (
          <Text size="caption" tone="warning" style={CONFLICT}>
            {conflictText}
          </Text>
        ) : item.path.length > 1 ? (
          item.path.slice(1).join(" › ")
        ) : undefined
      }
    >
      {customized && <Button variant="icon" icon="arrow.uturn.backward" size="m" onPress={() => onReset(item.id)} tooltip="Reset to Default" />}
      <ShortcutField
        combo={combo}
        mouse={mouse}
        onClearMouse={() => onClearMouse(item.id)}
        remappable={item.remappable}
        recording={recording}
        onRecord={() => void onRecord(item)}
        onClear={() => onClear(item)}
      />
    </Row>
  );
});

const CTRL_TAB_NOW: Record<CtrlTabChoice, string> = {
  step: "Steps through your tabs in order.",
  switcher: "Opens the recent tabs switcher.",
  custom: "Set to your own shortcuts below.",
};

function CtrlTabRow() {
  const choice = useCtrlTabChoice();
  return (
    <Row title={setting("appearance.ctrlTab").title} description={CTRL_TAB_NOW[choice]}>
      <Button title="Choose…" onPress={() => jumpToSetting(setting("appearance.ctrlTab"))} />
    </Row>
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

type ShortcutFieldProps = { combo: Shortcut; mouse?: Shortcut; remappable: boolean; recording: boolean; onRecord: () => void; onClear: () => void; onClearMouse: () => void };

function ShortcutField({ mouse, onClearMouse, ...keys }: ShortcutFieldProps) {
  if (!mouse) return <KeyField {...keys} />;
  return (
    <View style={FIELDS}>
      <KeyField {...keys} />
      <MouseField button={mouse} onClear={onClearMouse} />
    </View>
  );
}

function MouseField({ button, onClear }: { button: Shortcut; onClear: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps} style={KEY_FIELD}>
      <KeyCap keys={[formatShortcut(button)]} hovered={hovered} />
      {hovered ? (
        <Pressable onPress={onClear} tooltip="Remove Mouse Shortcut" style={CLEAR}>
          <Symbol name="xmark.circle.fill" size={11} color={theme.textTertiary} style={{ width: 14, height: 14 }} />
        </Pressable>
      ) : null}
    </View>
  );
}

function KeyField({ combo, remappable, recording, onRecord, onClear }: Omit<ShortcutFieldProps, "mouse" | "onClearMouse">) {
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
const FIELDS = { flexDirection: "row", alignItems: "center", gap: space.s } as const;
const KEY_FIELD = { minWidth: 110, justifyContent: "center" } as const;
const CLEAR = { position: "absolute", right: space.xs } as const;
