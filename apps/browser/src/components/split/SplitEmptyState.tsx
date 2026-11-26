import { fixupUrl, suggestionKey, type Suggestion as BarSuggestion } from "@ardia/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { findNodeHandle, Pressable, View, type TextInput } from "react-native";
import { useTheme } from "../ui/theme";
import { useTab, useWindowId } from "../../state/browser/hooks";
import { claimFocusTag, heroBarFocus } from "../../state/focus/focusClaims";
import { navigate } from "../../state/tabs/actions";
import { openFromBar, switchFromBar } from "../../state/omnibox/openFromBar";
import { copyText } from "../../state/app/system";
import { runBarAction, runBarExtension } from "../../state/omnibox/runBar";
import { closeEmptySplitPaneOnEscape, movesIntoSplitPane, replaceSplitPane } from "../../state/splits/actions";
import { useSplitPaneIds, useSplitSuggestions } from "../../state/splits/hooks";
import { tabLabel } from "../../state/browser/model";
import { noteSplit } from "../../state/telemetry/usage";
import { Panel, SearchField, shadow, space, Symbol, Text, useHover } from "../ui";
import { EMPTY_STATE_WIDTH, emptyPaneFieldSurface, emptyStateRadius, SPLIT_ROW_HEIGHT, splitColors, splitRowRadius } from "./tokens";
import { Favicon } from "../favicon/Favicon";
import { SuggestionIcon, suggestionLabels } from "../omnibox/SuggestionRow";
import { useSuggestions } from "../omnibox/useSuggestions";
import { useSteadyRows } from "../omnibox/steadyRows";

export function SplitEmptyState({ tabId, focused }: { tabId: string; focused: boolean }) {
  const theme = useTheme();
  const [typing, setTyping] = useState(focused);
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const suggestions = useSplitSuggestions(tabId);
  const windowId = useWindowId();
  const input = useRef<TextInput>(null);
  const wasFocused = useRef(focused);
  useEffect(() => {
    const activated = focused && !wasFocused.current;
    wasFocused.current = focused;
    if (!activated) return;
    setTyping(true);
    input.current?.focus();
    claimFocusTag(windowId, heroBarFocus(tabId), () => findNodeHandle(input.current));
  }, [focused, windowId, tabId]);
  const profileId = useTab(tabId, (t) => t?.profileId ?? "");
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const typed = text.trim().length > 0;
  const paneIds = useSplitPaneIds(tabId);
  const suggested = useSuggestions({ text, active: typed, windowId, profileId, currentTabId: tabId, scope: null, preventInline: true, switchToOpenTab: true }).items;
  const [room, setRoom] = useState<{ pane: number; header: number } | null>(null);
  const fits = room ? Math.max(0, Math.floor((room.pane - 2 * (space.xl + space.ml) - room.header - space.s) / SPLIT_ROW_HEIGHT)) : undefined;
  const ranked = useMemo(() => {
    const seen = new Set<string>();
    const typedUrl = fixupUrl(text.trim())?.replace(/\/$/, "");
    return suggested.flatMap((s) => {
      const row = s.kind === "page" && s.tabId && paneIds.includes(s.tabId) ? (s.url.replace(/\/$/, "") === typedUrl ? { ...s, tabId: undefined } : null) : s;
      if (!row || seen.has(suggestionKey(row))) return [];
      seen.add(suggestionKey(row));
      return [row];
    });
  }, [suggested, paneIds, text]);
  const fitted = useMemo(() => ({ items: ranked.slice(0, fits) }), [ranked, fits]);
  const { hovered: overRows, hoverProps: rowsHover } = useHover();
  const items = useSteadyRows(fitted, text, overRows, suggestionKey).value.items;
  const pickedIndex = Math.max(0, pickedKey ? items.findIndex((s) => suggestionKey(s) === pickedKey) : 0);
  const selectedId = !typed && selected && suggestions.includes(selected) ? selected : null;
  const choose = (s: BarSuggestion) => {
    noteSplit("splitPaneSuggestionPicks");
    switch (s.kind) {
      case "page":
        if (!s.tabId) return openFromBar(s.url, tabId, "current");
        return movesIntoSplitPane(tabId, s.tabId) ? replaceSplitPane(tabId, s.tabId) : switchFromBar(s.tabId, s.url, tabId, "current");
      case "calc":
        copyText(s.value);
        setText(s.value);
        return setPickedKey(null);
      case "action":
        return runBarAction(s.id, windowId);
      case "extension":
        return runBarExtension(s, windowId);
      default:
        return openFromBar(s.url, tabId, "current");
    }
  };
  const go = () => {
    const pick = items[pickedIndex] ?? ranked[0];
    if (typed && pick) choose(pick);
    else if (selectedId) {
      noteSplit("splitSuggestionKeyPicks");
      replaceSplitPane(tabId, selectedId);
    } else if (text.trim()) navigate(tabId, text.trim());
  };
  const move = (step: 1 | -1) => {
    if (typed) {
      const next = items[(pickedIndex + step + items.length) % Math.max(items.length, 1)];
      return setPickedKey(next ? suggestionKey(next) : null);
    }
    const stops = suggestions.length + 1;
    const at = selectedId ? suggestions.indexOf(selectedId) : -1;
    setSelected(suggestions[((at + 1 + step + stops) % stops) - 1] ?? null);
  };

  return (
    <View
      style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl }}
      onLayout={(e) => {
        const pane = e.nativeEvent.layout.height;
        setRoom((r) => ({ pane, header: r?.header ?? 0 }));
      }}
    >
      <Panel
        fill={splitColors(theme.dark).emptyStateFill}
        radius={emptyStateRadius()}
        border={theme.ntpBarBorder}
        shadow={shadow.card}
        style={{ width: "100%", maxWidth: EMPTY_STATE_WIDTH, paddingVertical: space.ml }}
      >
        <View
          onLayout={(e) => {
            const header = e.nativeEvent.layout.height;
            setRoom((r) => ({ pane: r?.pane ?? 0, header }));
          }}
        >
          <Text weight="semibold" style={{ paddingHorizontal: space.xl, paddingTop: space.xs, paddingBottom: space.ml }}>
            Add a tab to this Split View
          </Text>
          {typing ? (
            <View style={{ height: SPLIT_ROW_HEIGHT, marginHorizontal: space.s, paddingHorizontal: space.ml, borderRadius: splitRowRadius(), justifyContent: "center", backgroundColor: theme.rowHover }}>
              <SearchField
                look="bare"
                surface={emptyPaneFieldSurface}
                autoFocus
                inputRef={input}
                value={text}
                onChangeText={(next) => {
                  setText(next);
                  setSelected(null);
                  setPickedKey(null);
                }}
                placeholder="Search or Ask a Question"
                onSubmit={go}
                onArrow={move}
                onEscape={() => {
                  if (text || selectedId) {
                    setText("");
                    setSelected(null);
                  } else if (!closeEmptySplitPaneOnEscape(tabId)) setTyping(false);
                }}
              />
            </View>
          ) : (
            <Row icon={<Symbol name="magnifyingglass" size={13} color={theme.textSecondary} style={{ width: 16, height: 16 }} />} label="Search or Ask a Question" secondary onPress={() => setTyping(true)} />
          )}
        </View>
        {(typed ? items.length : suggestions.length) > 0 && <View style={{ height: space.s }} />}
        {typed ? (
          <View {...rowsHover}>
            {items.map((s, i) => (
              <Completion key={i} suggestion={s} selected={i === pickedIndex} onHover={() => setPickedKey(suggestionKey(s))} onPress={() => choose(s)} />
            ))}
          </View>
        ) : (
          suggestions.map((id) => (
              <Suggestion key={id} tabId={id} selected={id === selectedId} onHover={() => setSelected(id)} onPress={() => replaceSplitPane(tabId, id)} />
            ))
        )}
      </Panel>
    </View>
  );
}

function Suggestion({ tabId, selected, onHover, onPress }: { tabId: string; selected: boolean; onHover: () => void; onPress: () => void }) {
  const tab = useTab(tabId);
  if (!tab) return null;
  return <Row icon={<Favicon url={tab.url} favicon={tab.favicon} profileId={tab.profileId} />} label={tabLabel(tab)} detail={tab.title} selected={selected} onHover={onHover} onPress={onPress} />;
}

function Completion({ suggestion, selected, onHover, onPress }: { suggestion: BarSuggestion; selected: boolean; onHover: () => void; onPress: () => void }) {
  const [label, detail] = suggestionLabels(suggestion);
  return <Row icon={<SuggestionIcon suggestion={suggestion} />} label={label} detail={detail ?? undefined} selected={selected} onHover={onHover} onPress={onPress} />;
}

function Row({
  icon,
  label,
  detail,
  secondary,
  selected,
  onHover,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  detail?: string;
  secondary?: boolean;
  selected?: boolean;
  onHover?: () => void;
  onPress: () => void;
}) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  useEffect(() => {
    if (hovered) onHover?.();
  }, [hovered]);
  const highlighted = selected ?? hovered;
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress}>
        {({ pressed }) => (
          <View
            style={{
              height: SPLIT_ROW_HEIGHT,
              marginHorizontal: space.s,
              paddingHorizontal: space.ml,
              borderRadius: splitRowRadius(),
              flexDirection: "row",
              alignItems: "center",
              gap: space.m,
              backgroundColor: pressed ? theme.rowSelected : highlighted ? theme.rowHover : undefined,
            }}
          >
            {icon}
            <Text numberOfLines={1} tone={secondary ? "textSecondary" : "textPrimary"} style={SHRINK}>
              {label}
              {detail ? <Text tone="textTertiary">{`  ${detail}`}</Text> : null}
            </Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

const SHRINK = { flexShrink: 1 } as const;
