import { EmptyState, ListRow, SearchField, space, Text } from "../ui";
import { useEffect, useMemo, useRef } from "react";
import { ScrollView, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type TextInput } from "react-native";
import { useTheme } from "../ui/theme";
import { search, snippetAround, splitByRanges, type SearchHit, type SearchRange } from "./searchMatch";
import {
  currentSettingsSearch,
  keySearchConsent,
  moveSettingsSelection,
  noteSettingsKeySearch,
  previewCommandKeys,
  revealCommandKeys,
  noteSettingsSearchEmpty,
  previewSetting,
  revealSetting,
  selectSettingsResult,
  setSettingsQuery,
  useSettingsSearch,
} from "../../state/settings/searchState";
import { paneTitle, settingsIndexWith, type SettingEntry } from "./settingsIndex";
import { officialKeywords } from "../../state/plugins/official";
import { currentPlugins } from "../../state/plugins/store";
import { useUnshownSettings } from "./Form";
import { settingsInk } from "./tokens";
import { PREVIEW_DELAY_MS, RESULT_GAP, RESULT_MIN_HEIGHT, RESULTS_BOTTOM, RESULTS_TOP, scrollToShow } from "./searchResultLayout";
import { commandsBoundTo, parseCombo } from "../../state/commands/comboQuery";
import { resolvedShortcuts, useMenuBarRevision, type MenuShortcut } from "../../state/commands/commandShortcuts";
import { formatShortcut } from "../../state/commands/shortcuts";
import { useSettings } from "../../state/browser/hooks";
import { useProfileOrder } from "../../state/profiles/hooks";
import { shortcutItems } from "../../state/settings/paneData";
import { useResource } from "../../state/settings/resources";

export type SettingsHit = SearchHit<SettingEntry>;
export type CommandKeyHit = { item: MenuShortcut; keys: string };

const KEY_SEARCH_SETTLE_MS = 1000;

export function useCommandKeyHits(query: string): CommandKeyHit[] {
  const combo = useMemo(() => parseCombo(query), [query]);
  const overrides = useSettings((s) => s.shortcuts);
  const profileOrder = useProfileOrder();
  const menuBar = useMenuBarRevision();
  const [items] = useResource(shortcutItems);
  return useMemo(() => {
    if (!combo || !items) return [];
    const resolved = resolvedShortcuts({ settings: { shortcuts: overrides }, profileOrder });
    const keys = formatShortcut(combo);
    return commandsBoundTo(combo, items, (id) => resolved.bindings.get(id)).map((item) => ({ item, keys }));
  }, [combo, items, overrides, profileOrder, menuBar]);
}

export function SettingsSearchField() {
  const query = useSettingsSearch((s) => s.query);
  const focusRequest = useSettingsSearch((s) => s.focusRequest);
  const input = useRef<TextInput>(null);
  const unshown = useUnshownSettings();
  const keyHits = useCommandKeyHits(query);
  useEffect(() => {
    if (!focusRequest) return;
    input.current?.focus();
    input.current?.setSelection(0, currentSettingsSearch().query.length);
  }, [focusRequest]);
  return (
    <View style={FIELD}>
      <SearchField
        inputRef={input}
        value={query}
        onChangeText={setSettingsQuery}
        placeholder="Search"
        onSubmit={() => {
          const { query, selected } = currentSettingsSearch();
          const keyHit = keyHits[selected];
          if (keyHit) return revealCommandKeys(keyHit.keys, "keyboard", selected);
          const hit = settingsResults(query, unshown)[selected - keyHits.length];
          if (hit) revealSetting(hit.entry, "keyboard", selected, unshown.has(hit.entry.id));
        }}
        onArrow={(step) => {
          const count = keyHits.length + settingsResults(currentSettingsSearch().query, unshown).length;
          if (count) moveSettingsSelection(step, count);
        }}
        onEscape={() => {
          if (currentSettingsSearch().query) setSettingsQuery("");
        }}
      />
    </View>
  );
}

const FIELD = { marginHorizontal: space.ml, marginBottom: space.ml } as const;

let cached: { query: string; unshown: ReadonlySet<string>; keywords: string; results: SettingsHit[] } = { query: "", unshown: new Set(), keywords: "", results: [] };

export function settingsResults(query: string, unshown: ReadonlySet<string>): SettingsHit[] {
  const extra = officialKeywords(currentPlugins());
  const keywords = JSON.stringify(extra);
  if (cached.query !== query || cached.unshown !== unshown || cached.keywords !== keywords) {
    cached = { query, unshown, keywords, results: search(settingsIndexWith(extra).filter((p) => !unshown.has(p.entry.id) || p.entry.needs), query) };
  }
  return cached.results;
}

export function SettingsSearchResults({ query }: { query: string }) {
  const selected = useSettingsSearch((s) => s.selected);
  const keyboardMove = useSettingsSearch((s) => s.keyboardMove);
  const unshown = useUnshownSettings();
  const results = settingsResults(query, unshown);
  const keyHits = useCommandKeyHits(query);
  const scroller = useRef<ScrollView>(null);
  const viewport = useRef({ offset: 0, height: 0 });
  const rows = useRef<{ top: number; height: number }[]>([]);
  const keyTarget = keyHits[selected]?.keys;
  const target = keyTarget ? undefined : results[selected - keyHits.length]?.entry;
  const empty = !results.length && !keyHits.length;

  useEffect(() => {
    viewport.current.offset = 0;
    scroller.current?.scrollTo({ y: 0, animated: false });
    if (empty && query.trim().length >= 2) noteSettingsSearchEmpty();
  }, [results, keyHits]);

  useEffect(() => {
    if (!keyHits.length) return;
    const consent = keySearchConsent();
    const timer = setTimeout(() => noteSettingsKeySearch(consent), KEY_SEARCH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [keyHits[0]?.keys]);

  useEffect(() => {
    if (!target && !keyTarget) return;
    const timer = setTimeout(() => (keyTarget ? previewCommandKeys(keyTarget) : target && previewSetting(target)), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [target, keyTarget]);

  useEffect(() => {
    if (!keyboardMove) return;
    const row = rows.current[selected];
    if (!row) return;
    const { offset, height } = viewport.current;
    const next = scrollToShow(row.top, row.height, offset, height, selected === 0);
    if (next === offset) return;
    viewport.current.offset = next;
    scroller.current?.scrollTo({ y: next, animated: false });
  }, [keyboardMove]);

  if (empty) {
    const combo = parseCombo(query);
    const subtitle = combo ? `No command or setting uses ${formatShortcut(combo)}.` : `Nothing matches “${query.trim()}”. Try a setting's name or a shorter word, like “dark” or “downloads”.`;
    return <EmptyState symbol="magnifyingglass" title="No Results" subtitle={subtitle} />;
  }
  return (
    <ScrollView
      ref={scroller}
      contentContainerStyle={RESULTS}
      scrollEventThrottle={16}
      onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => (viewport.current.offset = e.nativeEvent.contentOffset.y)}
      onLayout={(e: LayoutChangeEvent) => (viewport.current.height = e.nativeEvent.layout.height)}
    >
      {keyHits.map((hit, index) => (
        <View key={`keys:${hit.item.id}`} style={ROW_GAP} onLayout={(e) => void (rows.current[index] = { top: e.nativeEvent.layout.y, height: e.nativeEvent.layout.height })}>
          <CommandKeyRow hit={hit} selected={index === selected} rank={index} />
        </View>
      ))}
      {results.map((hit, at) => {
        const index = keyHits.length + at;
        return (
          <View key={hit.entry.id} style={ROW_GAP} onLayout={(e) => void (rows.current[index] = { top: e.nativeEvent.layout.y, height: e.nativeEvent.layout.height })}>
            <ResultRow hit={hit} selected={index === selected} rank={index} needs={unshown.has(hit.entry.id) ? (hit.entry.needs ?? null) : null} />
          </View>
        );
      })}
    </ScrollView>
  );
}

const RESULTS = { paddingHorizontal: space.ml, paddingTop: RESULTS_TOP, paddingBottom: RESULTS_BOTTOM } as const;
const ROW_GAP = { marginBottom: RESULT_GAP } as const;

function ResultRow({ hit, selected, rank, needs }: { hit: SettingsHit; selected: boolean; rank: number; needs: string | null }) {
  const theme = useTheme();
  const { entry } = hit;
  const primary = selected ? theme.onAccent : theme.textPrimary;
  const secondary = selected ? settingsInk.onAccentSecondary : theme.textSecondary;
  const showSection = entry.section !== entry.title && entry.section !== entry.paneTitle;
  const keyword = hit.note && entry.keywords?.includes(hit.note.text);
  const note = hit.note ? snippetAround(hit.note.text, hit.note.ranges) : null;
  return (
    <ListRow
      selected={selected}
      selectedTone="accent"
      onPress={() => {
        selectSettingsResult(rank);
        revealSetting(entry, "click", rank, !!needs);
      }}
    >
      <View style={RESULT_TEXT}>
        <Text lines={3} color={primary}>
          <Marked text={entry.title} ranges={hit.title} color={primary} />
        </Text>
        <Text size="caption" lines={2} color={secondary}>
          {entry.paneTitle}
          {showSection ? " › " : ""}
          {showSection ? <Marked text={entry.section} ranges={hit.section} color={secondary} /> : null}
        </Text>
        {note ? (
          <Text size="caption" lines={2} color={secondary}>
            {keyword ? "Also called “" : ""}
            <Marked text={note.text} ranges={note.ranges} color={secondary} />
            {keyword ? "”" : ""}
          </Text>
        ) : null}
        {needs ? (
          <Text size="caption" lines={2} color={secondary}>
            {needs}
          </Text>
        ) : null}
      </View>
    </ListRow>
  );
}

function CommandKeyRow({ hit, selected, rank }: { hit: CommandKeyHit; selected: boolean; rank: number }) {
  const theme = useTheme();
  const primary = selected ? theme.onAccent : theme.textPrimary;
  const secondary = selected ? settingsInk.onAccentSecondary : theme.textSecondary;
  return (
    <ListRow
      selected={selected}
      selectedTone="accent"
      onPress={() => {
        selectSettingsResult(rank);
        revealCommandKeys(hit.keys, "click", rank);
      }}
    >
      <View style={RESULT_TEXT}>
        <CommandKeyLine title={hit.item.title} keys={hit.keys} color={primary} />
        <Text size="caption" lines={2} color={secondary}>
          {[paneTitle("shortcuts"), ...hit.item.path].join(" › ")}
        </Text>
      </View>
    </ListRow>
  );
}

export function CommandKeyLine({ title, keys, color }: { title: string; keys: string; color: string }) {
  return (
    <View style={KEY_LINE}>
      <Text lines={1} color={color} style={KEY_LINE_TITLE}>
        {title}
      </Text>
      <Text lines={1} weight="bold" color={color} style={KEY_LINE_KEYS}>
        {`\u00a0\u2014\u00a0${keys}`}
      </Text>
    </View>
  );
}

function Marked({ text, ranges, color }: { text: string; ranges: SearchRange[]; color: string }) {
  return (
    <>
      {splitByRanges(text, ranges).map((part, i) =>
        part.highlighted ? (
          <Text key={i} weight="bold" color={color}>
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

const KEY_LINE = { flexDirection: "row", alignItems: "baseline" } as const;
const KEY_LINE_TITLE = { flexShrink: 1 } as const;
const KEY_LINE_KEYS = { flexShrink: 0 } as const;
const RESULT_TEXT = { flex: 1, minHeight: RESULT_MIN_HEIGHT, justifyContent: "center", paddingVertical: space.xs } as const;
