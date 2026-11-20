import { memo, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Animated, PanResponder, Pressable, ScrollView, StyleSheet, TextInput, View, type ViewProps } from "react-native";
import { hapticTick } from "../../state/app/system";
import { pickLibraryItem } from "../../state/library/actions";
import { useLibraryItems } from "../../state/library/hooks";
import type { ProfileItem } from "../../state/library/items";
import {
  addLibraryProfile,
  changeLibraryProfileIcon,
  chooseLibraryProfileColor,
  deleteLibraryProfile,
  moveLibraryProfile,
  renameLibraryProfile,
  showLibraryProfileMenu,
} from "../../state/library/profileEdits";
import { Button, ContextMenuArea, font, hairline, hex, iconButton, shadow, OutsidePressArea, radius, space, Symbol, Text, typeFace, useHover, useTheme, weight } from "../ui";
import { curve } from "../ui/motion";
import { profileAccent } from "../ui/theme";
import { usePressScaleMotion } from "../ui/motion";
import { ProfileBadge } from "../profiles/ProfileIcons";
import { PROFILE_COLOR_CHOICES } from "../profiles/profileMenu";
import { CURSOR_KEYS, useLibraryCursor } from "./useLibraryCursor";
import type { LibraryKeyPress } from "./libraryKeys";
import type { WindowedListHandle } from "./WindowedList";
import { cardTint, LIBRARY } from "./tokens";
import { useLibraryFocus } from "./useLibraryFocus";
import { libraryOf } from "../../state/library/library";
import { tabCount } from "./format";

const C = LIBRARY.cards;
const PITCH = C.width + C.gap;
const FILL = { flex: 1 } as const;
const ROW = { flexGrow: 1, flexDirection: "row", gap: C.gap, padding: C.pad, paddingTop: space.s } as const;
const HEADER = { flexDirection: "row", alignItems: "center", gap: space.m, minHeight: C.badge } as const;
const NAME = { flex: 1 } as const;
const COUNT = { paddingLeft: C.badge + space.m } as const;
const FOOTER = { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: "auto" } as const;
const ADD = { justifyContent: "center" } as const;
const ADD_RING = { width: C.add, height: C.add, borderRadius: C.add / 2, borderWidth: C.addRing, alignItems: "center", justifyContent: "center" } as const;
const NO_SCROLL: RefObject<WindowedListHandle | null> = { current: { reveal: () => {}, toTop: () => {} } };
const RENAME_KEYS = [{ key: "Escape" }];
const EDIT_KEYS = [...CURSOR_KEYS, { key: "Backspace", metaKey: true }];

type DragController = { start(id: string): void; move(dx: number): void; end(commit: boolean): void };
type CardEdits = { rename(id: string): void; renamed(id: string, text: string | null): void; drag: DragController };

export function ProfileCards({ windowId, shown, entry, empty }: { windowId: string; shown: boolean; entry: RefObject<(() => void) | null>; empty: ReactNode }) {
  const theme = useTheme();
  const items = useLibraryItems(windowId, "profiles");
  const focusTarget = useRef<View>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const keys = items.map((item) => item.id);
  const cursor = useLibraryCursor({
    windowId,
    keys,
    columns: Math.max(1, items.length),
    list: NO_SCROLL,
    focusTarget,
    onOpen: (id) => pickLibraryItem(windowId, "profiles", id),
  });
  if (shown) entry.current = cursor.enter;
  const hasItems = items.length > 0;
  useEffect(() => {
    if (hasItems && shown) focusTarget.current?.focus();
  }, [hasItems, shown]);
  const drag = useCardDrag(keys);

  const edits = useRef<CardEdits>({ rename: () => {}, renamed: () => {}, drag: drag.controller }).current;
  edits.rename = setRenaming;
  edits.renamed = (id, text) => {
    if (text !== null) renameLibraryProfile(id, text);
    setRenaming(null);
    if (libraryOf(windowId).open) focusTarget.current?.focus();
  };

  const onKeyDown: ViewProps["onKeyDown"] = (event) => {
    if (renaming || !libraryOf(windowId).open) return;
    const { key, metaKey, ctrlKey, altKey, shiftKey }: LibraryKeyPress = event.nativeEvent;
    const at = cursor.cursor;
    const bare = !ctrlKey && !altKey && !shiftKey;
    if (at && bare && metaKey && key === "Backspace") return void deleteLibraryProfile(at, windowId);
    if (metaKey) return;
    if (at && bare && key === "Enter") return setRenaming(at);
    cursor.onKeyDown?.(event);
  };

  const lifted = items.find((item) => item.id === drag.dragging);
  if (!items.length) return <>{empty}</>;
  return (
    <View ref={focusTarget} {...cursor.focus} focusable enableFocusRing={false} keyDownEvents={EDIT_KEYS} onKeyDown={onKeyDown} style={FILL}>
      <ScrollView horizontal contentContainerStyle={ROW} style={FILL}>
        {items.map((item) => (
          <ProfileCard
            key={item.id}
            item={item}
            windowId={windowId}
            highlighted={cursor.cursor === item.id}
            renaming={renaming === item.id}
            lifted={drag.dragging === item.id}
            offset={drag.offsetOf(item.id)}
            edits={edits}
          />
        ))}
        <View style={ADD}>
          <View style={[ADD_RING, { backgroundColor: theme.panel, borderColor: theme.pinnedRestingStroke }]}>
            <Button
              variant="icon"
              icon="plus"
              size="l"
              box={C.add - 2 * C.addRing}
              capsule
              weight="semibold"
              color={theme.accent}
              tooltip="New Profile"
              onPress={() => void addLibraryProfile(windowId)}
            />
          </View>
        </View>
        {lifted ? <LiftedCard item={lifted} index={items.indexOf(lifted)} offset={drag.offsetOf(lifted.id)} /> : null}
      </ScrollView>
    </View>
  );
}

const settle = (value: Animated.Value, toValue: number) => Animated.timing(value, { toValue, duration: C.settle, easing: curve.enter, useNativeDriver: true });

function useCardDrag(order: string[]) {
  const offsets = useRef(new Map<string, Animated.Value>()).current;
  const offsetOf = useCallback(
    (id: string) => {
      let value = offsets.get(id);
      if (!value) offsets.set(id, (value = new Animated.Value(0)));
      return value;
    },
    [offsets],
  );
  const [dragging, setDragging] = useState<string | null>(null);
  const state = useRef({ id: "", from: 0, to: 0, order, pending: false });
  state.current.order = order;
  const joined = order.join("\n");

  useLayoutEffect(() => {
    if (!state.current.pending) return;
    state.current.pending = false;
    offsets.forEach((value) => value.setValue(0));
  }, [joined]);

  const controller = useRef<DragController>({
    start(id) {
      const from = state.current.order.indexOf(id);
      Object.assign(state.current, { id, from, to: from, pending: false });
      setDragging(id);
    },
    move(dx) {
      const { id, from, order } = state.current;
      const last = order.length - 1;
      offsetOf(id).setValue(Math.max(-from * PITCH - C.dragSlack, Math.min((last - from) * PITCH + C.dragSlack, dx)));
      const to = Math.max(0, Math.min(last, Math.round(from + dx / PITCH)));
      if (to === state.current.to) return;
      state.current.to = to;
      hapticTick();
      order.forEach((other, j) => {
        if (other !== id) settle(offsetOf(other), from < j && j <= to ? -PITCH : to <= j && j < from ? PITCH : 0).start();
      });
    },
    end(commit) {
      const { id, from, to } = state.current;
      setDragging(null);
      if (!commit || from === to) {
        offsets.forEach((value) => settle(value, 0).start());
        return;
      }
      state.current.pending = true;
      moveLibraryProfile(id, to);
    },
  }).current;

  return { dragging, offsetOf, controller };
}

const ProfileCard = memo(function ProfileCard({
  item,
  windowId,
  highlighted,
  renaming,
  lifted,
  offset,
  edits,
}: {
  item: ProfileItem;
  windowId: string;
  highlighted: boolean;
  renaming: boolean;
  lifted: boolean;
  offset: Animated.Value;
  edits: CardEdits;
}) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const press = usePressScaleMotion(!renaming, C.pressScale);
  const badge = useRef<View>(null);
  const accent = profileAccent(item.profile);
  const count = tabCount(item.tabCount);
  const id = item.id;
  const renamingNow = useRef(renaming);
  renamingNow.current = renaming;
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => !renamingNow.current && Math.abs(g.dx) > C.dragStart && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderGrant: () => edits.drag.start(id),
      onPanResponderMove: (_, g) => edits.drag.move(g.dx),
      onPanResponderRelease: () => edits.drag.end(true),
      onPanResponderTerminate: () => edits.drag.end(false),
      onPanResponderTerminationRequest: () => false,
    }),
  ).current;
  const openMenu = () => void showLibraryProfileMenu(id, { windowId, anchor: badge.current, colors: PROFILE_COLOR_CHOICES, rename: () => edits.rename(id) });
  const tint = cardTint(theme, accent, hovered || highlighted || lifted ? "hover" : "rest");

  return (
    <Animated.View
      {...pan.panHandlers}
      {...hoverProps}
      style={{ width: C.width, opacity: lifted ? 0 : 1, transform: [{ translateX: offset }] }}
    >
      <ContextMenuArea onContextMenu={openMenu} style={FILL}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={item.profile.name}
          accessibilityHint={count}
          accessibilityState={{ selected: item.current }}
          accessibilityActions={[{ name: "rename", label: "Rename" }, { name: "delete", label: "Delete Profile" }]}
          onAccessibilityAction={({ nativeEvent }) =>
            nativeEvent.actionName === "rename" ? edits.rename(id) : nativeEvent.actionName === "delete" ? void deleteLibraryProfile(id, windowId) : undefined
          }
          disabled={renaming}
          onPress={() => pickLibraryItem(windowId, "profiles", id)}
          onPressIn={press.onPressIn}
          onPressOut={press.onPressOut}
          style={FILL}
        >
          {({ pressed }) => (
            <CardFace
              item={item}
              fill={pressed && !renaming ? cardTint(theme, accent, "pressed") : tint}
              ring={item.current || highlighted ? C.selectedBorder : StyleSheet.hairlineWidth}
              ringColor={item.current ? accent : highlighted ? theme.accent : theme.pinnedRestingStroke}
              scale={press.scale}
              badge={
                <Pressable ref={badge} collapsable={false} tooltip="Change Icon" accessibilityLabel="Change Icon" onPress={() => void changeLibraryProfileIcon(id, windowId, badge.current)}>
                  <ProfileBadge profile={item.profile} size={C.badge} />
                </Pressable>
              }
              name={renaming ? <RenameField initial={item.profile.name} onDone={(text) => edits.renamed(id, text)} /> : null}
              color={renaming ? null : <Button variant="icon" icon="paintpalette" size="s" tooltip="Color" onPress={() => void chooseLibraryProfileColor(id, PROFILE_COLOR_CHOICES)} />}
              more={<Button variant="icon" icon="ellipsis" size="s" tooltip="More" onPress={openMenu} />}
            />
          )}
        </Pressable>
      </ContextMenuArea>
    </Animated.View>
  );
});

function CardFace({
  item,
  fill,
  ring,
  ringColor,
  scale,
  badge,
  name,
  color,
  more,
}: {
  item: ProfileItem;
  fill: string;
  ring: number;
  ringColor: string;
  scale?: Animated.Value | null;
  badge: ReactNode;
  name: ReactNode;
  color: ReactNode;
  more: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Animated.View
      style={[
        { flex: 1, minHeight: C.minHeight, padding: space.l, paddingBottom: space.m, gap: space.xs, borderRadius: LIBRARY.grid.radius, backgroundColor: fill, borderWidth: ring, borderColor: ringColor },
        scale ? { transform: [{ scale }] } : null,
      ]}
    >
      <View style={HEADER}>
        {badge}
        {name ?? (
          <Text weight="semibold" lines={1} style={NAME}>
            {item.profile.name}
          </Text>
        )}
        {color}
      </View>
      <Text size="caption" tone="textSecondary" lines={1} style={COUNT}>
        {tabCount(item.tabCount)}
      </Text>
      <View style={FOOTER}>
        <View tooltip="Drag to reorder" accessibilityElementsHidden>
          <Symbol name="arrow.left.arrow.right" size={C.handleGlyph} color={theme.textTertiary} style={{ width: C.handleBox, height: C.handleBox }} />
        </View>
        {more}
      </View>
    </Animated.View>
  );
}

function LiftedCard({ item, index, offset }: { item: ProfileItem; index: number; offset: Animated.Value }) {
  const theme = useTheme();
  const accent = profileAccent(item.profile);
  const glyph = (name: string) => <Symbol name={name} size={iconButton.s.glyph} color={theme.textSecondary} style={{ width: iconButton.s.box, height: iconButton.s.box }} />;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: space.s,
        bottom: C.pad,
        left: C.pad + index * PITCH,
        width: C.width,
        borderRadius: LIBRARY.grid.radius,
        backgroundColor: hex(theme.panel),
        shadowColor: shadow.card.color,
        shadowOpacity: shadow.card.opacity[theme.dark ? "dark" : "light"],
        shadowRadius: shadow.card.radius,
        shadowOffset: { width: shadow.card.offset[0], height: shadow.card.offset[1] },
        transform: [{ translateX: offset }, { scale: C.liftScale }],
      }}
    >
      <CardFace
        item={item}
        fill={cardTint(theme, accent, "hover")}
        ring={item.current ? C.selectedBorder : StyleSheet.hairlineWidth}
        ringColor={item.current ? accent : theme.pinnedRestingStroke}
        badge={<ProfileBadge profile={item.profile} size={C.badge} />}
        name={null}
        color={glyph("paintpalette")}
        more={glyph("ellipsis")}
      />
    </Animated.View>
  );
}

function RenameField({ initial, onDone }: { initial: string; onDone: (text: string | null) => void }) {
  const theme = useTheme();
  const [text, setText] = useState(initial);
  const latest = useRef(initial);
  latest.current = text;
  const input = useRef<TextInput>(null);
  const focus = useLibraryFocus(input);
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  useEffect(() => {
    const later = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(later);
  }, []);
  return (
    <OutsidePressArea onOutsidePress={() => finish(text)} style={[NAME, { height: C.renameHeight, justifyContent: "center", paddingHorizontal: space.s, marginLeft: -space.s - hairline.ring, borderRadius: radius.control, backgroundColor: theme.field, borderWidth: hairline.ring * 2, borderColor: theme.fieldBorder }]}>
      <TextInput
        ref={input}
        value={text}
        onFocus={focus.onFocus}
        onChangeText={setText}
        placeholder="Profile name"
        placeholderTextColor={theme.textTertiary}
        selectionColor={theme.selection}
        selectTextOnFocus
        enableFocusRing={false}
        accessibilityLabel="Profile name"
        onSubmitEditing={() => finish(text)}
        onBlur={() => {
          focus.onBlur();
          setTimeout(() => finish(latest.current), 0);
        }}
        keyDownEvents={RENAME_KEYS}
        onKeyDown={(e) => e.nativeEvent.key === "Escape" && finish(null)}
        style={{ ...font.body, ...typeFace(), fontWeight: weight.semibold, color: theme.textPrimary, paddingVertical: 0, paddingHorizontal: 0 }}
      />
    </OutsidePressArea>
  );
}
