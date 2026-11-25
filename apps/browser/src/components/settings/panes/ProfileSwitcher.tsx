import { Box, Button, capsule, ContextMenuArea, SlidingThumb, space, Text, useHover, useSlidingThumb } from "../../ui";
import { hapticTick } from "../../../state/app/system";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Animated, PanResponder, Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { hex, useTheme } from "../../ui/theme";
import { useProfileOrder, useProfileRecords } from "../../../state/profiles/hooks";
import { currentProfileOrder } from "../../../state/browser/current";
import { reorderProfiles } from "../../../state/profiles/actions";
import { useProfile } from "../../../state/browser/hooks";
import { sharingProfiles } from "../../../state/profiles/profiles";
import { ProfileBadge } from "../../profiles/ProfileIcons";
import { replaceSettingsPlace, SETTINGS_WINDOW_ID } from "../../../state/settings/settingsWindows";
import { openProfileItemMenu } from "../../profiles/profileMenu";
import { requestCreateProfile } from "../../../state/profiles/createProfileRequest";
import { curve } from "../../ui/motion";
import { settingsMotion } from "../tokens";
import { noteSettingsProfilePick } from "../../../state/telemetry/usage";

export const listOf = (names: string[], joiner = "and") => (names.length <= 2 ? names.join(` ${joiner} `) : `${names.slice(0, -1).join(", ")}, ${joiner} ${names.at(-1)}`);

export function useSharedWith(profileId: string): string[] {
  const order = useProfileOrder();
  const profiles = useProfileRecords();
  return useMemo(() => {
    const others = sharingProfiles({ profiles, profileOrder: order }, profileId);
    return others.length ? order.filter((id) => id === profileId || others.includes(id)) : [profileId];
  }, [order, profiles, profileId]);
}

function pickProfile(profileId: string) {
  noteSettingsProfilePick();
  replaceSettingsPlace(profileId);
}

const settle = (value: Animated.Value, toValue: number) =>
  Animated.timing(value, { toValue, duration: settingsMotion.profileRowSettle, easing: curve.enter, useNativeDriver: true });

let savedStripX = 0;

export function ProfileBar({ selectedId }: { selectedId: string }) {
  const theme = useTheme();
  const order = useProfileOrder();
  const offsets = useRef(new Map<string, Animated.Value>()).current;
  const thumb = useSlidingThumb(selectedId);
  const slots = thumb.slots;
  const scroller = useRef<ScrollView>(null);
  const view = useRef({ x: savedStripX, width: 0 });
  const restored = useRef(false);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const offsetOf = (id: string) => {
    let v = offsets.get(id);
    if (!v) offsets.set(id, (v = new Animated.Value(0)));
    return v;
  };
  const [dragging, setDragging] = useState<string | null>(null);
  const drag = useRef({ id: "", from: 0, to: 0, reorderPending: false });

  useLayoutEffect(() => {
    if (!drag.current.reorderPending) return;
    drag.current.reorderPending = false;
    offsets.forEach((v) => v.setValue(0));
  }, [order]);

  const revealSelected = (animated: boolean) => {
    const slot = slots.get(selectedRef.current);
    const { x, width } = view.current;
    if (!slot || !width) return;
    const left = slot.x + TRAY_PAD;
    const right = left + slot.width + TRAY_PAD;
    let next = x;
    if (left - TRAY_PAD < x) next = Math.max(0, left - TRAY_PAD * 2);
    else if (right > x + width) next = right - width + TRAY_PAD;
    if (!restored.current) {
      restored.current = true;
      view.current.x = next;
      savedStripX = next;
      if (next > 0) scroller.current?.scrollTo({ x: next, animated: false });
      return;
    }
    if (next !== x) scroller.current?.scrollTo({ x: next, animated });
  };

  useEffect(() => {
    revealSelected(true);
  }, [selectedId]);

  const controller = useRef({
    start(id: string) {
      const from = currentProfileOrder().indexOf(id);
      drag.current = { id, from, to: from, reorderPending: false };
      setDragging(id);
    },
    move(dx: number) {
      const { id, from } = drag.current;
      const ids = currentProfileOrder();
      const slot = slots.get(id);
      const first = slots.get(ids[0] ?? "");
      const last = slots.get(ids.at(-1) ?? "");
      if (!slot || !first || !last) return;
      const shift = Math.max(first.x - slot.x, Math.min(last.x + last.width - slot.x - slot.width, dx));
      offsetOf(id).setValue(shift);
      const center = slot.x + slot.width / 2 + shift;
      const to = ids.filter((other) => {
        const s = slots.get(other);
        return other !== id && !!s && s.x + s.width / 2 < center;
      }).length;
      if (to === drag.current.to) return;
      drag.current.to = to;
      hapticTick();
      const gap = slot.width + PILL_GAP;
      ids.forEach((other, j) => {
        if (other === id) return;
        settle(offsetOf(other), from < j && j <= to ? -gap : to <= j && j < from ? gap : 0).start();
      });
    },
    end(commit: boolean) {
      const { id, from, to } = drag.current;
      setDragging(null);
      if (!commit || from === to) {
        offsets.forEach((v) => settle(v, 0).start());
        return;
      }
      const ids = currentProfileOrder().filter((x) => x !== id);
      ids.splice(to, 0, id);
      drag.current.reorderPending = true;
      reorderProfiles(ids);
    },
  }).current;

  return (
    <Box row center gap="s" style={BAR}>
      <View style={[TRAY, { backgroundColor: theme.groupFill, borderColor: theme.groupBorder }]}>
        <ScrollView
          ref={scroller}
          horizontal
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={(e) => {
            view.current.x = e.nativeEvent.contentOffset.x;
            savedStripX = view.current.x;
          }}
          onLayout={(e) => {
            view.current.width = e.nativeEvent.layout.width;
            revealSelected(false);
          }}
          onContentSizeChange={() => revealSelected(false)}
          contentContainerStyle={TRAY_SCROLL}
        >
          <View style={TRAY_CONTENT}>
            <SlidingThumb x={thumb.x} width={thumb.width} shift={offsetOf(selectedId)} style={[THUMB, { backgroundColor: theme.formAccent }]} />
            {order.map((id) => (
              <ProfilePill
                key={id}
                profileId={id}
                selected={id === selectedId}
                offset={offsetOf(id)}
                lifted={dragging === id}
                controller={controller}
                onLayout={(e) => {
                  thumb.measure(id, e);
                  if (id === selectedRef.current) revealSelected(false);
                }}
              />
            ))}
          </View>
        </ScrollView>
      </View>
      <Button variant="icon" icon="plus" box={PILL_HEIGHT} glyph={PILL_PLUS_GLYPH} capsule tooltip="Create Profile" onPress={() => void requestCreateProfile()} />
    </Box>
  );
}

type DragController = { start(id: string): void; move(dx: number): void; end(commit: boolean): void };

function ProfilePill({
  profileId,
  selected,
  offset,
  lifted,
  controller,
  onLayout,
}: {
  profileId: string;
  selected: boolean;
  offset: Animated.Value;
  lifted: boolean;
  controller: DragController;
  onLayout: (e: LayoutChangeEvent) => void;
}) {
  const theme = useTheme();
  const profile = useProfile(profileId, (p) => p);
  const { hovered, hoverProps } = useHover();
  const anchor = useRef<View>(null);
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 3,
      onPanResponderGrant: () => controller.start(profileId),
      onPanResponderMove: (_, g) => controller.move(g.dx),
      onPanResponderRelease: () => controller.end(true),
      onPanResponderTerminate: () => controller.end(false),
      onPanResponderTerminationRequest: () => false,
    }),
  ).current;
  if (!profile) return null;
  const fill = selected ? undefined : lifted ? hex(theme.panel) : hovered ? theme.rowHover : undefined;

  return (
    <Animated.View
      {...pan.panHandlers}
      onLayout={onLayout}
      style={{ zIndex: lifted ? 1 : 0, transform: [{ translateX: offset }] }}
    >
      <ContextMenuArea onContextMenu={() => void openProfileItemMenu(profileId, "settings", SETTINGS_WINDOW_ID, anchor.current)}>
        <View {...hoverProps} ref={anchor} collapsable={false}>
          <Pressable
            onPress={() => !selected && pickProfile(profileId)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={profile.name}
            style={[PILL, { backgroundColor: fill }]}
          >
            <ProfileBadge profile={profile} size={PILL_BADGE} />
            <Text tone={selected ? "onAccent" : "textPrimary"} numberOfLines={1} ardiaCentersCapitals style={PILL_NAME}>
              {profile.name}
            </Text>
          </Pressable>
        </View>
      </ContextMenuArea>
    </Animated.View>
  );
}

const PILL_HEIGHT = 28;
const PILL_BADGE = 18;
const PILL_PLUS_GLYPH = 13;
const PILL_GAP = space.xxs;
const PILL_NAME_MAX = 160;
const TRAY_PAD = space.xxs;
const BAR = { marginTop: space.xxl } as const;
const TRAY = { flex: 1, borderRadius: capsule(PILL_HEIGHT + TRAY_PAD * 2), borderWidth: StyleSheet.hairlineWidth * 2, overflow: "hidden" } as const;
const TRAY_SCROLL = { padding: TRAY_PAD } as const;
const TRAY_CONTENT = { flexDirection: "row", gap: PILL_GAP } as const;
const THUMB = { borderRadius: capsule(PILL_HEIGHT) } as const;
const PILL = { height: PILL_HEIGHT, borderRadius: capsule(PILL_HEIGHT), flexDirection: "row", alignItems: "center", gap: space.s, paddingLeft: space.xs, paddingRight: space.m } as const;
const PILL_NAME = { maxWidth: PILL_NAME_MAX } as const;
