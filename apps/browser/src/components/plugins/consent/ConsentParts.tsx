import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import type { CredentialProviderSpec } from "../../../lib/pluginCredentialProvider";
import { groupedConsent, type ConsentLine } from "../../../state/plugins/consentLine";
import { nativeLoop, reduceMotion, Symbol, Text, useTheme, withAlpha } from "../../ui";
import { capsule, ink, lineHeight, monoFace, perLook, proseLineHeight, radius } from "../../ui/tokens";
import { BrandBadge } from "../../vaults/VaultParts";
import { CONSENT_MOTION, CONSENT_SHEET as C } from "./tokens";

export function PluginIcon({ name, icon, provider }: { name: string; icon: string | null; provider: CredentialProviderSpec | null }) {
  const theme = useTheme();
  if (provider) return <BrandBadge provider={name} size="xl" symbol={provider.symbol ?? undefined} accent={provider.accent ?? undefined} />;
  const edge = theme.dark ? withAlpha(ink.white, C.iconEdge.dark) : withAlpha(ink.black, C.iconEdge.light);
  return (
    <View style={[ICON, { borderColor: edge }]}>
      <View pointerEvents="none" style={SHEEN} />
      <Symbol name={icon ?? "puzzlepiece.fill"} size={C.icon.glyph} weight="semibold" color={theme.onAccent} style={ICON_GLYPH} />
    </View>
  );
}

export function ConsentSections({ lines }: { lines: readonly ConsentLine[] }) {
  const theme = useTheme();
  const border = theme.highContrastText ? theme.textTertiary : theme.groupBorder;
  return (
    <View style={SECTIONS}>
      {groupedConsent(lines).map((section) => (
        <View key={section.group}>
          <Text size="small" weight="semibold" tone="textSecondary" accessibilityRole="header" style={SECTION_TITLE}>
            {section.title}
          </Text>
          <View style={[GROUP, { backgroundColor: theme.groupFill, borderColor: border }]}>
            {section.lines.map((line, index) => (
              <ConsentRow key={`${index}:${line.text}`} line={line} first={index === 0} />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

export function ConsentChips({ items, code }: { items: readonly string[]; code: boolean }) {
  const theme = useTheme();
  const mono = monoFace();
  return (
    <View style={CHIPS}>
      {items.map((item, index) => (
        <View key={`${index}:${item}`} style={[CHIP, { backgroundColor: theme.chipFill }]}>
          <Text size={code ? "tiny" : "caption"} tone="textSecondary" style={code ? mono : undefined}>
            {item}
          </Text>
        </View>
      ))}
    </View>
  );
}

function ConsentRow({ line, first }: { line: ConsentLine; first: boolean }) {
  const theme = useTheme();
  return (
    <View accessible accessibilityLabel={line.text} style={ROW}>
      {first ? null : <View pointerEvents="none" style={[DIVIDER, { backgroundColor: theme.divider }]} />}
      <View style={ROW_ICON}>
        <Symbol name={line.icon} size={C.rowIcon.glyph} color={theme.icon} style={ROW_GLYPH()} />
      </View>
      <View style={ROW_TEXT}>
        <Text style={TITLE()}>{line.title}</Text>
        {line.detail ? (
          <Text size="small" tone="textSecondary" style={DETAIL()}>
            {line.detail}
          </Text>
        ) : null}
        {line.items ? <ConsentChips items={line.items} code={line.code === true} /> : null}
      </View>
    </View>
  );
}

const FADE_BANDS = Array.from({ length: C.fadeBands }, (_, i) => (i + 1) / (C.fadeBands + 1));

export function EdgeFade({ edge }: { edge: "top" | "bottom" }) {
  const theme = useTheme();
  const bands = edge === "top" ? [...FADE_BANDS].reverse() : FADE_BANDS;
  return (
    <View pointerEvents="none" style={edge === "top" ? FADE_TOP : FADE_BOTTOM}>
      {bands.map((alpha, i) => (
        <View key={i} style={[FADE_BAND, { backgroundColor: withAlpha(theme.panel, alpha) }]} />
      ))}
    </View>
  );
}

export function InstallBar({ fraction }: { fraction: number | null }) {
  const theme = useTheme();
  const sweep = useRef(new Animated.Value(0)).current;
  const fill = useRef(new Animated.Value(fraction ?? 0)).current;
  const still = reduceMotion() === true;
  const indeterminate = fraction === null;
  useEffect(() => {
    if (!indeterminate) return;
    const legs = still
      ? [
          { to: 1, ms: CONSENT_MOTION.pulseMs / 2 },
          { to: 0, ms: CONSENT_MOTION.pulseMs / 2 },
        ]
      : [{ to: 1, ms: CONSENT_MOTION.sweepMs }];
    const loop = nativeLoop(sweep, legs);
    loop.start();
    return () => loop.stop();
  }, [indeterminate, still]);
  useEffect(() => {
    if (fraction === null) return;
    const run = Animated.timing(fill, { toValue: fraction, ...CONSENT_MOTION.fraction, useNativeDriver: true });
    run.start();
    return () => run.stop();
  }, [fraction]);
  const width = C.bar.width;
  const segment = width * C.bar.segment;
  const bar = indeterminate
    ? still
      ? { width, opacity: sweep.interpolate({ inputRange: [0, 1], outputRange: [CONSENT_MOTION.pulseFloor, 1] }) }
      : { width: segment, transform: [{ translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [-segment, width] }) }] }
    : { width, transform: [{ translateX: fill.interpolate({ inputRange: [0, 1], outputRange: [-width / 2, 0] }) }, { scaleX: fill }] };
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={fraction === null ? undefined : { min: 0, max: 100, now: Math.round(fraction * 100) }}
      style={[TRACK, { backgroundColor: withAlpha(theme.textPrimary, theme.highContrastText ? C.bar.trackContrast : C.bar.track) }]}
    >
      <Animated.View style={[FILL, { backgroundColor: theme.formAccent }, bar]} />
    </View>
  );
}

const FADE_TOP = { position: "absolute", top: 0, left: 0, right: 0 } as const;
const FADE_BOTTOM = { position: "absolute", bottom: 0, left: 0, right: 0 } as const;
const FADE_BAND = { height: C.fade / C.fadeBands } as const;
const ICON = {
  width: C.icon.box,
  height: C.icon.box,
  borderRadius: radius.panel,
  backgroundColor: C.iconFill,
  borderWidth: StyleSheet.hairlineWidth,
  alignItems: "center",
  justifyContent: "center",
  overflow: "hidden",
} as const;
const SHEEN = { position: "absolute", top: 0, left: 0, right: 0, height: C.icon.box / 2, backgroundColor: withAlpha(ink.white, C.iconSheen) } as const;
const ICON_GLYPH = { width: C.icon.box, height: C.icon.box } as const;
const SECTIONS = { gap: C.sectionGap } as const;
const SECTION_TITLE = { paddingHorizontal: C.rowPadX, marginBottom: C.sectionTitleGap } as const;
const GROUP = { borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth * 2, overflow: "hidden" } as const;
const ROW = { flexDirection: "row", alignItems: "flex-start", gap: C.rowGap, paddingHorizontal: C.rowPadX, paddingVertical: C.rowPadY } as const;
const DIVIDER = { position: "absolute", top: 0, right: 0, left: C.rowPadX + C.rowIcon.box + C.rowGap, height: StyleSheet.hairlineWidth } as const;
const ROW_ICON = { width: C.rowIcon.box, alignItems: "center" } as const;
const ROW_TEXT = { flex: 1 } as const;
const CHIPS = { flexDirection: "row", flexWrap: "wrap", gap: C.chipGap, marginTop: C.chipsGap } as const;
const CHIP = { borderRadius: radius.control, paddingHorizontal: C.chipPadX, paddingVertical: C.chipPadY } as const;
const TRACK = { width: C.bar.width, height: C.bar.height, borderRadius: capsule(C.bar.height), overflow: "hidden" } as const;
const FILL = { height: C.bar.height, borderRadius: capsule(C.bar.height) } as const;
const DETAIL = perLook(() => ({ lineHeight: proseLineHeight.small, marginTop: C.detailGap }));
const TITLE = perLook(() => ({ lineHeight: lineHeight.body }));
const ROW_GLYPH = perLook(() => ({ width: C.rowIcon.box, height: lineHeight.body }));
