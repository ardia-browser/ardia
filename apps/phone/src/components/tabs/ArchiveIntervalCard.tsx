import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, type ViewInstance } from "react-native";
import Animated, { FadeIn, FadeOut, withTiming } from "react-native-reanimated";
import { dismissArchiveCard, hideArchiveCardSoon } from "../../state/browse/archiveCard";
import { setArchiveInterval } from "../../state/settings/actions";
import { usePreferences } from "../../state/settings/hooks";
import { AUTO_ARCHIVE_INTERVALS, autoArchiveTitle, type AutoArchiveInterval } from "../../state/tabs/tabModels";
import { archiveCardLayout, capsule, ChromeSurface, deckChromeLayout, deckChromeMotion, FloatingMenu, screenReaderActions, font, ink, radius, shadowRadius, space, Symbol, tabsLayout, tabsMotion, useTheme, useReduceMotion, type MenuItem, SystemGlyph } from "../ui";
import { MenuTrigger } from "../ui/MenuTrigger";

import { ArchiveTile } from "./ArchiveTile";

const INTERVALS = Object.keys(AUTO_ARCHIVE_INTERVALS) as AutoArchiveInterval[];

export function ArchiveIntervalCard({ edgeY }: { edgeY: number }) {
  const theme = useTheme();
  const reduceMotion = useReduceMotion();
  const interval = usePreferences((p) => p.autoArchiveInterval);
  const picker = useRef<ViewInstance>(null);
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
        <Pressable ref={picker} accessibilityRole="button" accessibilityLabel="Archive Inactive Tabs" accessibilityValue={{ text: autoArchiveTitle(interval) }} onPress={() => setOpen(true)} style={styles.picker}>
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

function intervalItems(interval: AutoArchiveInterval): MenuItem[] {
  return INTERVALS.map((option) => ({
    label: autoArchiveTitle(option),
    checked: option === interval,
    onPress: () => {
      if (option === interval) return;
      setArchiveInterval(option);
      hideArchiveCardSoon();
    },
  }));
}

export function ArchiveCapsule({ centerY, safeSide, sideInset }: { centerY: number; safeSide: number; sideInset: number }) {
  const theme = useTheme();
  const reduceMotion = useReduceMotion();
  const interval = usePreferences((p) => p.autoArchiveInterval);
  const title = autoArchiveTitle(interval);
  return (
    <Animated.View
      entering={reduceMotion ? FadeIn.duration(tabsMotion.fade) : capsuleIn}
      exiting={reduceMotion ? FadeOut.duration(tabsMotion.fade) : capsuleOut}
      pointerEvents="box-none"
      testID="archiveCapsulePlace"
      style={[styles.capsulePlace, { top: centerY - deckChromeLayout.archiveHeight / 2, paddingHorizontal: safeSide + sideInset }]}
    >
      <ChromeSurface testID="archiveCapsule" shape="capsule" cornerRadius={capsule(deckChromeLayout.archiveHeight)} interactive={false} dark={theme.dark} style={styles.capsule}>
        <View {...screenReaderActions([{ name: "dismiss", label: "Dismiss", run: () => dismissArchiveCard() }])} style={styles.capsuleRow}>
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={deckChromeLayout.archiveTextMinScale} style={[styles.capsuleText, { color: theme.headerText }]}>
            Archive inactive tabs
          </Text>
          <MenuTrigger items={intervalItems(interval)} trigger="tap" fixedOrder place={{ right: safeSide + sideInset, width: tabsLayout.menuWidth }}>
            {({ onPress }) => (
              <Pressable accessibilityRole="button" accessibilityLabel={`Archive inactive tabs, ${title}`} onPress={onPress} style={styles.capsulePicker}>
                <Text style={[styles.capsuleChoice, { color: theme.formAccent }]}>{title}</Text>
                <SystemGlyph testID="archiveCapsuleChevrons" systemName="chevron.up.chevron.down" pointSize={11} weight="semibold" fitted name="chevronUpChevronDown" size={deckChromeLayout.archiveChevron} color={theme.formAccent} />
              </Pressable>
            )}
          </MenuTrigger>
          <Pressable testID="archiveCapsuleDismiss" accessibilityRole="button" accessibilityLabel="Dismiss" onPress={() => dismissArchiveCard()} style={styles.capsuleDismiss}>
            <SystemGlyph testID="archiveCapsuleDismissGlyph" systemName="xmark" pointSize={13} weight="semibold" name="xmark" size={deckChromeLayout.archiveDismissGlyph} color={theme.secondaryLabel} />
          </Pressable>
        </View>
      </ChromeSurface>
    </Animated.View>
  );
}

const capsuleIn = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: deckChromeMotion.archiveScale }] },
    animations: { opacity: withTiming(1, { duration: tabsMotion.fade }), transform: [{ scale: withTiming(1, { duration: tabsMotion.fade }) }] },
  };
};

const capsuleOut = () => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ scale: 1 }] },
    animations: { opacity: withTiming(0, { duration: tabsMotion.fade }), transform: [{ scale: withTiming(deckChromeMotion.archiveScale, { duration: tabsMotion.fade }) }] },
  };
};

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
    shadowOpacity: 0.18,
    shadowRadius: shadowRadius.lifted,
    elevation: 12,
  },
  label: { flexDirection: "row", alignItems: "center", gap: space.m },
  capsulePlace: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  capsule: { width: "100%", maxWidth: deckChromeLayout.archiveMaxWidth, minHeight: deckChromeLayout.archiveHeight, justifyContent: "center" },
  capsuleRow: { flexDirection: "row", alignItems: "center", gap: deckChromeLayout.archiveSpacing, minHeight: deckChromeLayout.archiveHeight, paddingLeft: deckChromeLayout.archiveLead, paddingRight: deckChromeLayout.archiveTrail },
  capsuleText: { flex: 1, fontSize: deckChromeLayout.archiveText },
  capsuleChoice: { fontSize: deckChromeLayout.archiveText },
  capsulePicker: { flexDirection: "row", alignItems: "center", gap: deckChromeLayout.archivePickerSpacing, minHeight: deckChromeLayout.archivePickerHeight },
  capsuleDismiss: { width: deckChromeLayout.archiveDismiss, height: deckChromeLayout.archiveDismiss, alignItems: "center", justifyContent: "center" },
  picker: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 44, paddingHorizontal: space.s + 2, borderRadius: radius.row },
});
