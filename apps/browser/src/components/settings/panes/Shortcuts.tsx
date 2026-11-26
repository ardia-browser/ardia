import { cancelShortcutRecording, recordShortcut, type MenuShortcut, useCtrlTabKeys } from "../../../state/commands/commandShortcuts";
import { Box, Button, EmptyState, PopUp, SearchField, space, Text, type Option } from "../../ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { useSettings } from "../../../state/browser/hooks";
import type { Settings } from "../../../state/settings/settings";
import { setMouseShortcut, setShortcutOverride, updateSettings } from "../../../state/settings/actions";
import { openUrls } from "../../../state/browser/actions";
import { Anchor, Group, Row, SectionHeader, SettingToggle } from "../Form";
import { setting, type SettingId } from "../settingsIndex";
import { shortcutSearchHit } from "../shortcutSearch";
import { shortcutItems } from "../../../state/settings/paneData";
import { useResource } from "../../../state/settings/resources";
import { comboKey, formatShortcut, type Shortcut } from "../../../state/commands/shortcuts";
import { splitLinkModifierOf, type PeekModifier, type SplitLinkModifier } from "../../../state/settings/settings";
import { keyText } from "../../../state/commands/keyText";
import type { SettingsPlace } from "../../../state/settings/settingsWindows";
import { jumpToSetting, keySearchConsent, noteShortcutsKeySearch, setShortcutsQuery, useSettingsSearch } from "../../../state/settings/searchState";
import { bindsCombo, parseCombo } from "../../../state/commands/comboQuery";
import { commandBarKeywords } from "../../../state/omnibox/barActions";
import { noteShortcutsKeywordFind } from "../../../state/telemetry/settingsPickerCounts";
import { ShortcutConflict, ShortcutField, useResolvedShortcuts } from "../ShortcutField";
import { applyRecordedShortcut, clearShortcut, NO_SHORTCUT } from "../../../state/settings/recordedShortcut";

type Filter = "all" | "customized" | "conflicts";

const EXTENSION_ITEM = "openExtension:";
const KEY_SEARCH_SETTLE_MS = 1000;
const KEY_SEARCH_CANCEL_PRESS_MS = 600;

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

  const resolved = useResolvedShortcuts(items);
  const byId = useMemo(() => new Map((items ?? []).map((item) => [item.id, item])), [items]);
  const effective = (item: MenuShortcut): Shortcut => resolved.bindings.get(item.id)?.[0] ?? NO_SHORTCUT;
  const conflictsOf = (item: MenuShortcut) => resolved.conflictsOf(item.id).flatMap((id) => byId.get(id) ?? []);

  const record = async (item: MenuShortcut) => {
    setRecording(item.id);
    const combo = await recordShortcut();
    setRecording(null);
    applyRecordedShortcut(item, combo);
  };

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

  const hitOf = (item: MenuShortcut) =>
    shortcutSearchHit(query, [item.title, item.path.join(" "), formatShortcut(effective(item)), formatShortcut(resolved.mouse.get(item.id) ?? NO_SHORTCUT)], commandBarKeywords(item.id));
  const matches = (item: MenuShortcut) => (combo ? (resolved.bindings.get(item.id) ?? []).some((binding) => bindsCombo(binding, combo)) : hitOf(item) !== null);

  const shown = (items ?? []).filter((item) => {
    if (!matches(item)) return false;
    if (filter === "customized") return !!overrides[item.id] || resolved.mouse.has(item.id);
    if (filter === "conflicts") return conflictsOf(item).length > 0;
    return true;
  });
  const menuItems = shown.filter((i) => !i.id.startsWith(EXTENSION_ITEM));
  const extensionItems = shown.filter((i) => i.id.startsWith(EXTENSION_ITEM));
  const menus = [...new Set(menuItems.map((i) => i.path[0] ?? ""))];
  const customizedCount = Object.keys(overrides).length + resolved.mouse.size;
  const found = shown.length > 0;
  const foundByKeyword = !combo && !!query.trim() && shown.some((item) => hitOf(item) === "keyword");

  useEffect(() => {
    if (!combo || items === null) return;
    const recorded = recordedQuery.current === query;
    const consent = keySearchConsent();
    const timer = setTimeout(() => noteShortcutsKeySearch(recorded ? "recorded" : "typed", found, consent), recorded ? 0 : KEY_SEARCH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [combo && comboKey(combo), items === null]);

  useEffect(() => {
    if (!foundByKeyword) return;
    const consent = keySearchConsent();
    const timer = setTimeout(() => noteShortcutsKeywordFind(consent), KEY_SEARCH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [query, foundByKeyword]);

  const itemRow = (item: MenuShortcut) => {
    const others = conflictsOf(item);
    return (
      <Row
        key={item.id}
        icon={null}
        title={item.title}
        description={
          others.length ? (
            <ShortcutConflict titles={others.map((o) => o.title)} />
          ) : item.path.length > 1 ? (
            item.path.slice(1).join(" › ")
          ) : undefined
        }
      >
        {overrides[item.id] && <Button variant="icon" icon="arrow.uturn.backward" size="m" onPress={() => setShortcutOverride(item.id, null)} tooltip="Reset to Default" />}
        <ShortcutField
          combo={effective(item)}
          mouse={resolved.mouse.get(item.id)}
          onClearMouse={() => setMouseShortcut(item.id, null)}
          remappable={item.remappable}
          recording={recording === item.id}
          onRecord={() => void record(item)}
          onClear={() => clearShortcut(item)}
        />
      </Row>
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

const ORDER_NOW: Record<Settings["tabSwitcherOrder"], string> = { recent: "Goes to your recent tabs", inOrder: "Steps through your tabs in order" };
const VIEW_NOW: Record<Settings["tabSwitcherView"], string> = { thumbnails: ", with page previews.", compactList: ", with a compact list.", none: "." };

function CtrlTabRow() {
  const keys = useCtrlTabKeys();
  const order = useSettings((s) => s.tabSwitcherOrder);
  const view = useSettings((s) => s.tabSwitcherView);
  const description = keys === "custom" ? "Set to your own shortcuts below." : `${ORDER_NOW[order]}${VIEW_NOW[view]}`;
  return (
    <Row title={setting("appearance.ctrlTab").title} description={description}>
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

const TOOLBAR = { flexDirection: "row", alignItems: "center", gap: space.m } as const;
const FILL = { flex: 1 } as const;
const NO_MATCH = { marginTop: space.huge } as const;
const EXTENSIONS = { marginTop: space.xxxl } as const;
