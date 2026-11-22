import { useEffect, useRef, useState } from "react";
import { findNodeHandle, Pressable, View, type TextInput } from "react-native";
import { useTheme } from "../ui/theme";
import { useTab, useWindowId } from "../../state/browser/hooks";
import { claimFocusTag, heroBarFocus } from "../../state/focus/focusClaims";
import { navigate } from "../../state/tabs/actions";
import { replaceSplitPane } from "../../state/splits/actions";
import { useSplitSuggestions } from "../../state/splits/hooks";
import { tabLabel } from "../../state/browser/model";
import { noteSplit } from "../../state/telemetry/usage";
import { Panel, SearchField, shadow, space, Symbol, Text, useHover } from "../ui";
import { EMPTY_STATE_WIDTH, emptyStateRadius, SPLIT_ROW_HEIGHT, splitColors, splitRowRadius } from "./tokens";
import { Favicon } from "../favicon/Favicon";
import { t } from "../../lib/uiLanguage";


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
  const selectedId = selected && suggestions.includes(selected) ? selected : null;
  const go = () => {
    if (selectedId) {
      noteSplit("splitSuggestionKeyPicks");
      replaceSplitPane(tabId, selectedId);
    } else if (text.trim()) navigate(tabId, text.trim());
  };
  const move = (step: 1 | -1) => {
    const stops = suggestions.length + 1;
    const at = selectedId ? suggestions.indexOf(selectedId) : -1;
    setSelected(suggestions[((at + 1 + step + stops) % stops) - 1] ?? null);
  };

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl }}>
      <Panel
        fill={splitColors(theme.dark).emptyStateFill}
        radius={emptyStateRadius()}
        border={theme.ntpBarBorder}
        shadow={shadow.card}
        style={{ width: "100%", maxWidth: EMPTY_STATE_WIDTH, paddingVertical: space.ml }}
      >
        <Text weight="semibold" style={{ paddingHorizontal: space.xl, paddingTop: space.xs, paddingBottom: space.ml }}>
          Add a tab to this Split View
        </Text>
        {typing ? (
          <View style={{ height: SPLIT_ROW_HEIGHT, marginHorizontal: space.s, paddingHorizontal: space.ml, borderRadius: splitRowRadius(), justifyContent: "center", backgroundColor: theme.rowHover }}>
            <SearchField
              look="bare"
              autoFocus
              inputRef={input}
              value={text}
              onChangeText={(next) => {
                setText(next);
                setSelected(null);
              }}
              placeholder={t(`Search or Ask a Question`)}
              onSubmit={go}
              onArrow={move}
              onEscape={() => {
                setText("");
                setSelected(null);
                setTyping(false);
              }}
            />
          </View>
        ) : (
          <Row icon={<Symbol name="magnifyingglass" size={13} color={theme.textSecondary} style={{ width: 16, height: 16 }} />} label={t(`Search or Ask a Question`)} secondary onPress={() => setTyping(true)} />
        )}
        {suggestions.length > 0 && <View style={{ height: space.s }} />}
        {suggestions.map((id) => (
          <Suggestion key={id} tabId={id} selected={id === selectedId} onHover={() => setSelected(id)} onPress={() => replaceSplitPane(tabId, id)} />
        ))}
      </Panel>
    </View>
  );
}

function Suggestion({ tabId, selected, onHover, onPress }: { tabId: string; selected: boolean; onHover: () => void; onPress: () => void }) {
  const tab = useTab(tabId);
  if (!tab) return null;
  return <Row icon={<Favicon url={tab.url} favicon={tab.favicon} profileId={tab.profileId} />} label={tabLabel(tab)} detail={tab.title} selected={selected} onHover={onHover} onPress={onPress} />;
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
