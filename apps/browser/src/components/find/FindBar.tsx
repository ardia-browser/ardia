import { useShortcutHint, withShortcut } from "../../state/commands/commandShortcuts";
import { claimFocusTag, findFocus } from "../../state/focus/focusClaims";
import { useEffect, useRef, useState } from "react";
import { findNodeHandle, TextInput, View } from "react-native";
import { useTheme } from "../ui/theme";
import { webviews } from "../../state/tabs/webviewHandles";
import { useFind, useTab } from "../../state/browser/hooks";
import { currentTab } from "../../state/browser/current";
import { setFind as setTabFind } from "../../state/windows/actions";
import { closeFind, findStep, noteFind, submitRepeatsKey, takeFindFocusRequest } from "../../state/find/actions";
import type { FindState } from "../../state/browser/types";
import { Button, ClosingView, Divider, font, useLiveWhile, Panel, radius, shadow, space, Symbol, Text, usePopoverMotion, usePopoverMotionStyle, usePopoverPresenceOf, useStillOpen, whileOpen } from "../ui";
import { replaceInField } from "../../state/site/selection";
import { FIND_WIDTH } from "./tokens";

export function FindBar({ tabId }: { tabId: string }) {
  return <FindBarPresence key={tabId} tabId={tabId} />;
}

function FindBarPresence({ tabId }: { tabId: string }) {
  const hasPage = useTab(tabId, (t) => !!t?.url);
  const find = useFind(tabId);
  const { shown, closing, onClosed } = usePopoverPresenceOf(find.open && hasPage ? find : null);
  return shown ? <FindBarPanel tabId={tabId} find={shown} closing={closing} onClosed={onClosed} /> : null;
}

const FIND_KEYS = [
  { key: "Escape" },
  { key: "Enter" },
  { key: "Enter", shiftKey: true },
  { key: "Enter", altKey: true },
  { key: "Enter", altKey: true, shiftKey: true },
];

function FindBarPanel({ tabId, find, closing, onClosed }: { tabId: string; find: FindState; closing: boolean; onClosed: () => void }) {
  const previousHint = useShortcutHint("findPrevious");
  const nextHint = useShortcutHint("findNext");
  const theme = useTheme();
  const input = useRef<TextInput>(null);
  const appear = usePopoverMotion(closing, onClosed);
  const motion = usePopoverMotionStyle(appear, "top right");
  const act = whileOpen(closing, useStillOpen(!closing));
  const live = useLiveWhile(closing);
  useEffect(() => {
    if (!find.focusRequest) return;
    takeFindFocusRequest(tabId);
    input.current?.focus();
    input.current?.setSelection(0, find.query.length);
    const windowId = currentTab(tabId)?.windowId;
    if (windowId) claimFocusTag(windowId, findFocus(tabId), () => findNodeHandle(input.current));
    if (find.query) void webviews.get(tabId)?.find(find.query, true, false);
  }, [find.focusRequest]);

  const setFind = (patch: Partial<FindState>) => setTabFind(tabId, patch);
  const enterAt = useRef(0);
  const run = (backwards: boolean, query = find.query, findNext = true) => {
    if (!query) setFind({ count: null, active: 0 });
    if (findNext && query) noteFind("stepped");
    void webviews.get(tabId)?.find(query, !backwards, findNext);
  };
  const close = act(() => closeFind(tabId));
  const [replacement, setReplacement] = useState("");
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), 2200);
    return () => clearTimeout(timer);
  }, [note]);
  const replace = act(async (all: boolean) => {
    if (!find.query) return;
    const { field, count } = await replaceInField(tabId, find.query, replacement, all);
    if (!field) return setNote({ text: "Not in a text field", error: true });
    if (all || !count) setNote({ text: count ? `${count} replaced` : "No matches", error: !count });
    run(false, find.query, false);
  });
  const none = find.count === 0 && !!find.query;

  return (
    <ClosingView
      closing={closing}
      style={{
        position: "absolute",
        top: space.ml,
        right: space.l,
        ...motion,
      }}
    >
      <Panel radius={radius.panel} border={theme.popoverBorder} shadow={shadow.popover} style={{ width: FIND_WIDTH }}>
        <View style={{ height: 40, flexDirection: "row", alignItems: "center", paddingLeft: space.l, paddingRight: space.xs, gap: space.xxs }}>
          <Symbol name="magnifyingglass" size={13} color={theme.textSecondary} style={{ width: 16, height: 16, marginRight: space.xs }} />
          <TextInput
            ref={input}
            autoFocus
            editable={!closing}
            value={find.query}
            onChangeText={live(act((query: string) => {
              setFind({ query });
              run(false, query, false);
            }))}
            placeholder="Find on Page"
            placeholderTextColor={theme.placeholder}
            selectionColor={theme.selection}
            enableFocusRing={false}
            onSubmitEditing={live(() => {
              if (!submitRepeatsKey(enterAt.current, Date.now())) run(false);
            })}
            keyDownEvents={FIND_KEYS}
            onKeyDown={live(act((e) => {
              const { key, shiftKey, ctrlKey, metaKey } = e.nativeEvent;
              if (key === "Escape") close();
              else if (key === "Enter" && !ctrlKey && !metaKey) {
                enterAt.current = Date.now();
                run(!!shiftKey);
              }
            }))}
            style={{ flex: 1, ...font.title, color: theme.textPrimary, paddingVertical: 0 }}
          />
          {none ? (
            <Text size="small" tone="destructive" style={{ marginRight: space.s }}>
              No results
            </Text>
          ) : find.count !== null && !!find.query ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.s, marginRight: space.s }}>
              <Text size="small" style={TABULAR}>
                {find.active}
              </Text>
              <Divider vertical thick length={12} />
              <Text size="small" tone="textSecondary" style={TABULAR}>
                {find.count}
              </Text>
            </View>
          ) : null}
          <Button variant="icon" icon="chevron.up" size="l" disabled={!find.count} onPress={act(() => findStep(tabId, true))} tooltip={withShortcut("Previous", previousHint)} />
          <Button variant="icon" icon="chevron.down" size="l" disabled={!find.count} onPress={act(() => findStep(tabId, false))} tooltip={withShortcut("Next", nextHint)} />
          <Divider vertical thick length={18} style={CLOSE_GAP} />
          <Button variant="icon" icon="xmark" size="l" onPress={close} tooltip="Done (Esc)" />
        </View>
        {find.replace && <Divider thick />}
        {find.replace && (
          <View style={{ height: 38, flexDirection: "row", alignItems: "center", paddingLeft: space.l, paddingRight: space.s, gap: space.xs }}>
            <Symbol name="arrow.triangle.swap" size={12} color={theme.textSecondary} style={{ width: 16, height: 16, marginRight: space.xs }} />
            <TextInput
              value={replacement}
              editable={!closing}
              onChangeText={live(act(setReplacement))}
              placeholder="Replace"
              placeholderTextColor={theme.placeholder}
              selectionColor={theme.selection}
              enableFocusRing={false}
              onSubmitEditing={live(() => void replace(false))}
              keyDownEvents={[{ key: "Escape" }]}
              onKeyDown={live(act((e) => e.nativeEvent.key === "Escape" && close()))}
              style={{ flex: 1, ...font.title, color: theme.textPrimary, paddingVertical: 0 }}
            />
            {note && (
              <Text size="small" tone={note.error ? "destructive" : "textSecondary"} style={{ marginRight: space.xxs }}>
                {note.text}
              </Text>
            )}
            <Button variant="text" look="toolbar" title="Replace" disabled={!find.query} onPress={() => void replace(false)} />
            <Button variant="text" look="toolbar" title="All" disabled={!find.query} onPress={() => void replace(true)} />
          </View>
        )}
      </Panel>
    </ClosingView>
  );
}

const TABULAR = { fontVariant: ["tabular-nums"] as "tabular-nums"[] };
const CLOSE_GAP = { marginHorizontal: space.xs } as const;
