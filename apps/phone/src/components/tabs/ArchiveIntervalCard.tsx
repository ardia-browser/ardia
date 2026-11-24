import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, type ViewInstance } from "react-native";
import Animated, { FadeIn, FadeOut, withTiming } from "react-native-reanimated";
import { dismissArchiveCard, hideArchiveCardSoon } from "../../state/browse/archiveCard";
import { setArchiveInterval } from "../../state/settings/actions";
import { usePreferences } from "../../state/settings/hooks";
import { AUTO_ARCHIVE_INTERVALS, autoArchiveTitle, type AutoArchiveInterval } from "../../state/tabs/tabModels";
import { archiveCardLayout, FloatingMenu, screenReaderActions, font, radius, shadowRadius, space, Symbol, tabsLayout, tabsMotion, useTheme, useReduceMotion, usePressStyle, controlSize, smoothCorners } from "../ui";

import { ArchiveTile } from "./ArchiveTile";

const INTERVALS = Object.keys(AUTO_ARCHIVE_INTERVALS) as AutoArchiveInterval[];

export function ArchiveIntervalCard({ edgeY }: { edgeY: number }) {
  const theme = useTheme();
  const reduceMotion = useReduceMotion();
  const interval = usePreferences((p) => p.autoArchiveInterval);
  const picker = useRef<ViewInstance>(null);
  const pickerStyle = usePressStyle("text", { style: styles.picker });
  const [open, setOpen] = useState(false);
  const side = archiveCardLayout.tile;
  return (
    <Animated.View
      entering={reduceMotion ? FadeIn.duration(tabsMotion.fade) : cardIn}
      exiting={reduceMotion ? FadeOut.duration(tabsMotion.fade) : cardOut}
      pointerEvents="box-none"
      testID="archiveCardPlace"
      style={[styles.place, { height: edgeY }]}
    >
      <View
        {...screenReaderActions([{ name: "dismiss", label: "Dismiss", run: () => dismissArchiveCard() }])}
        style={[styles.card, { backgroundColor: theme.panel, shadowColor: theme.trayShadow }]}
      >
        <View style={styles.label}>
          <ArchiveTile side={side} />
          <Text style={[font.body, { color: theme.label }]}>Archive Inactive Tabs</Text>
        </View>
        <Pressable ref={picker} accessibilityRole="button" accessibilityLabel="Archive Inactive Tabs" accessibilityValue={{ text: autoArchiveTitle(interval) }} onPress={() => setOpen(true)} style={pickerStyle}>
          <Text style={[font.body, { color: theme.secondaryLabel }]}>{autoArchiveTitle(interval)}</Text>
          <Symbol name="chevronUpChevronDown" size={14} color={theme.secondaryLabel} />
        </Pressable>
      </View>
      {open ? (
        <FloatingMenu
          anchor={picker}
          items={INTERVALS.map((option) => ({
            label: autoArchiveTitle(option),
            checked: option === interval,
            onPress: () => {
              if (option === interval) return;
              setArchiveInterval(option);
              hideArchiveCardSoon();
            },
          }))}
          place={{ top: 0, right: space.l, width: tabsLayout.menuWidth }}
          onDismiss={() => setOpen(false)}
        />
      ) : null}
    </Animated.View>
  );
}

const ENTRANCE_SCALE = 0.96;

const cardIn = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: ENTRANCE_SCALE }] },
    animations: { opacity: withTiming(1, { duration: tabsMotion.fade }), transform: [{ scale: withTiming(1, { duration: tabsMotion.fade }) }] },
  };
};

const cardOut = () => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ scale: 1 }] },
    animations: { opacity: withTiming(0, { duration: tabsMotion.fade }), transform: [{ scale: withTiming(ENTRANCE_SCALE, { duration: tabsMotion.fade }) }] },
  };
};

const styles = StyleSheet.create({
  place: { position: "absolute", top: 0, left: space.l, right: space.l, alignItems: "center", justifyContent: "flex-end" },
  card: {
    width: "100%",
    maxWidth: archiveCardLayout.maxWidth,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    rowGap: space.xs,
    paddingLeft: space.m + 2,
    paddingRight: space.xs,
    paddingVertical: space.m + 2,
    borderRadius: archiveCardLayout.radius,
    ...smoothCorners,
    shadowOpacity: 0.18,
    shadowRadius: shadowRadius.lifted,
    elevation: 12,
  },
  label: { flexDirection: "row", alignItems: "center", gap: space.m },
  picker: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: controlSize.hitTarget, paddingHorizontal: space.s + 2, borderRadius: radius.row, ...smoothCorners },
});
