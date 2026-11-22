import { useEffect, useRef } from "react";
import { StyleSheet, Text, TextInput, View, type TextInputInstance } from "react-native";
import { useBottomLift } from "../search/useKeyboardHeight";
import { closeFind, findNext, findPrevious, typeFind } from "../../state/page/actions";
import { useFindQuery, useFindResult } from "../../state/page/hooks";
import { findCount, findHasMatches } from "../../state/page/pagePrompts";
import { browseLayout, font, pageInk, space, Symbol, useTheme, type SymbolName, Tappable, slopToReach, controlRadius, smoothCorners } from "../ui";
import { dismissWords } from "../../lib/sharedWords";

const FIELD_HEIGHT = 40;

export function FindBar({ tabId }: { tabId: string }) {
  const theme = useTheme();
  const { lift } = useBottomLift();
  const query = useFindQuery();
  const result = useFindResult(tabId);
  const input = useRef<TextInputInstance>(null);
  useEffect(() => {
    const focus = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(focus);
  }, []);
  const count = findCount(result, query);
  const matches = findHasMatches(result, query);
  return (
    <View style={[styles.bar, { bottom: 0, paddingBottom: lift, backgroundColor: theme.canvas }]}>
      <View style={[styles.divider, { backgroundColor: theme.separator }]} />
      <View style={styles.row}>
        <View style={[styles.field, { backgroundColor: theme.fieldFill, borderColor: theme.fieldStroke, borderRadius: controlRadius(FIELD_HEIGHT) }, smoothCorners]}>
          <Symbol name="magnifyingglass" size={16} color={theme.foregroundSecondary} />
          <TextInput
            ref={input}
            accessibilityLabel="Find on Page"
            value={query}
            onChangeText={typeFind}
            onSubmitEditing={() => matches && findNext()}
            placeholder="Find on Page"
            placeholderTextColor={theme.foregroundTertiary}
            selectionColor={theme.spaceAccentInk}
            style={[font.body, styles.input, { color: theme.label }]}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            submitBehavior="submit"
            disableFullscreenUI
          />
          {count ? (
            <Text
              accessibilityLiveRegion="polite"
              style={[font.subheadline, styles.digits, { color: count.kind === "match" ? theme.foregroundSecondary : pageInk.findError }]}
              numberOfLines={1}
            >
              {count.label}
            </Text>
          ) : null}
        </View>
        <FindButton icon="chevronUp" label="Previous Match" enabled={matches} onPress={findPrevious} />
        <FindButton icon="chevronDown" label="Next Match" enabled={matches} onPress={findNext} />
        <Tappable kind="text" label={dismissWords.done} onPress={closeFind} style={styles.done}>
          <Text style={[font.body, styles.bold, { color: theme.spaceAccentInk }]}>{dismissWords.done}</Text>
        </Tappable>
      </View>
    </View>
  );
}

function FindButton({ icon, label, enabled, onPress }: { icon: SymbolName; label: string; enabled: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Tappable kind="icon" label={label} disabled={!enabled} hitSlop={slopToReach(browseLayout.findButton)} onPress={onPress} style={styles.button}>
      <Symbol name={icon} size={browseLayout.findGlyph} color={enabled ? theme.label : theme.tertiaryLabel} />
    </Tappable>
  );
}

const styles = StyleSheet.create({
  bar: { position: "absolute", left: 0, right: 0 },
  divider: { height: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.m, paddingVertical: space.s },
  field: {
    flex: 1,
    minHeight: FIELD_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: space.s,
    paddingHorizontal: space.m,
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: { flex: 1, paddingVertical: 0 },
  digits: { fontVariant: ["tabular-nums"] },
  button: { width: browseLayout.findButton, height: browseLayout.findButton, alignItems: "center", justifyContent: "center" },
  done: { minHeight: browseLayout.hitTarget, justifyContent: "center", paddingHorizontal: space.s },
  bold: { fontWeight: "600" },
});
