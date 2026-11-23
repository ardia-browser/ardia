import { useEffect, useRef, useState } from "react";
import { isHexColor } from "../../lib/color";
import { Animated, Image, StyleSheet, View } from "react-native";
import type { VaultCopyOutcome } from "../../state/vaults/actions";
import { brandAccent, brandOf } from "../../state/vaults/brands";
import { useVaultProvider, useVaultProviders } from "../../state/vaults/hooks";
import { NEUTRAL_BRAND_ACCENT } from "../../state/vaults/tokens";
import { Button, capsule, Crossfade, curve, iconButton, ink, radius, Symbol, useTheme, withAlpha } from "../ui";
import { VAULT_BADGE, VAULT_CODE, VAULT_MENU, VAULT_SETTINGS, VAULT_TILE_BADGE } from "./tokens";

export function BrandBadge({ provider, size = "s", tooltip, symbol, accent: given }: { provider: string; size?: keyof typeof VAULT_BADGE; tooltip?: string; symbol?: string; accent?: string }) {
  const theme = useTheme();
  useVaultProvider(provider);
  const accent = given && isHexColor(given) ? given : brandAccent(provider);
  const { box, glyph } = VAULT_BADGE[size];
  const solid = size !== "s";
  return (
    <View tooltip={tooltip} style={{ width: box, height: box, borderRadius: size === "xl" ? radius.panel : solid ? radius.tile : radius.control, backgroundColor: solid ? accent : withAlpha(accent, VAULT_MENU.badgeAlpha), alignItems: "center", justifyContent: "center" }}>
      <Symbol name={symbol ?? brandOf(provider).symbol} size={glyph} weight="semibold" color={solid ? theme.onAccent : accent} style={{ width: box, height: box }} />
    </View>
  );
}

export function useManagerName() {
  const providers = useVaultProviders();
  return (id: string) => providers.find((p) => p.id === id)?.name ?? brandOf(id).name;
}

export function CopyButton({ label, onCopy }: { label: string; onCopy: () => Promise<VaultCopyOutcome> }) {
  const theme = useTheme();
  const [copied, flash] = useCopiedFlash();
  const busy = useRef(false);
  const press = async () => {
    if (busy.current) return;
    busy.current = true;
    const outcome = await onCopy().finally(() => (busy.current = false));
    if (outcome === "copied") flash();
  };
  return (
    <Button variant="icon" size="m" tooltip={copied ? "Copied" : `Copy ${label}`} onPress={() => void press()}>
      <Crossfade id={copied ? "copied" : "copy"}>
        <Symbol name={copied ? "checkmark" : "doc.on.doc"} size={iconButton.m.glyph} color={theme.icon} style={COPY_GLYPH} />
      </Crossfade>
    </Button>
  );
}

export function useCopiedFlash(): [boolean, () => void] {
  const [flashes, setFlashes] = useState(0);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!flashes) return;
    const timer = setTimeout(() => setCopied(false), VAULT_SETTINGS.copiedMs);
    return () => clearTimeout(timer);
  }, [flashes]);
  return [copied, () => (setCopied(true), setFlashes((n) => n + 1))];
}

export function VaultAppIcon({ provider, symbol, neutral, badge }: { provider: string; symbol?: string; neutral?: boolean; badge?: { provider: string; ground: string } }) {
  const theme = useTheme();
  const { box, glyph, radius: corner } = VAULT_MENU.icon;
  const fill = neutral ? NEUTRAL_BRAND_ACCENT : brandAccent(provider);
  const edge = theme.dark ? withAlpha(ink.white, VAULT_MENU.iconEdge.dark) : withAlpha(ink.black, VAULT_MENU.iconEdge.light);
  const tile = (
    <View style={{ width: box, height: box, borderRadius: corner, backgroundColor: fill, borderWidth: StyleSheet.hairlineWidth, borderColor: edge, alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
      <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: box / 2, backgroundColor: withAlpha(ink.white, VAULT_MENU.iconSheen) }} />
      <Symbol name={symbol ?? brandOf(provider).symbol} size={glyph} weight="semibold" color={theme.onAccent} style={{ width: box, height: box }} />
    </View>
  );
  if (!badge) return tile;
  return (
    <View style={{ width: box, height: box }}>
      {tile}
      <ManagerBadge provider={badge.provider} ground={badge.ground} />
    </View>
  );
}

const ARDIA_MARK = require("../../../assets/app-icon.png");

export function ManagerBadge({ provider, ground }: { provider: string; ground: string }) {
  const theme = useTheme();
  const { size, cut, glyph, outset } = VAULT_TILE_BADGE;
  const outer = size + 2 * cut;
  const mark = { width: size, height: size, borderRadius: capsule(size) };
  return (
    <View pointerEvents="none" accessibilityLabel={brandOf(provider).name} style={{ position: "absolute", right: -outset, bottom: -outset, width: outer, height: outer, borderRadius: capsule(outer), backgroundColor: ground, alignItems: "center", justifyContent: "center" }}>
      {provider === "ardia" ? (
        <View style={{ ...mark, overflow: "hidden", alignItems: "center", justifyContent: "center" }}>
          <Image source={ARDIA_MARK} style={{ width: size * VAULT_TILE_BADGE.ardiaZoom, height: size * VAULT_TILE_BADGE.ardiaZoom }} />
        </View>
      ) : (
        <View style={{ ...mark, backgroundColor: brandAccent(provider), alignItems: "center", justifyContent: "center" }}>
          <Symbol name={brandOf(provider).symbol} size={glyph} weight="bold" color={theme.onAccent} style={{ width: size, height: size }} />
        </View>
      )}
    </View>
  );
}

const HALF_SPAN = 180;
const QUARTER = 45;

export type RingInk = { arc: string; warning: string; track: string };

export function CountdownRing({ expiresAt, period, paused = false, size = VAULT_CODE.ring, stroke = VAULT_CODE.stroke, colors }: { expiresAt: number; period: number; paused?: boolean; size?: number; stroke?: number; colors?: RingInk }) {
  const theme = useTheme();
  const periodMs = Math.max(1, period * 1000);
  const elapsed = () => Math.min(1, Math.max(0, 1 - (expiresAt - Date.now()) / periodMs));
  const progress = useRef(new Animated.Value(elapsed())).current;
  const [expiring, setExpiring] = useState(expiresAt - Date.now() <= VAULT_CODE.expiringMs);
  useEffect(() => {
    const left = expiresAt - Date.now();
    const warn = setTimeout(() => setExpiring(true), Math.max(0, left - VAULT_CODE.expiringMs));
    progress.setValue(elapsed());
    if (paused) return () => clearTimeout(warn);
    const run = Animated.timing(progress, { toValue: 1, duration: Math.max(0, left), easing: curve.linear, useNativeDriver: true });
    run.start();
    return () => (clearTimeout(warn), run.stop());
  }, [expiresAt, paused]);
  const ring = colors ?? { arc: theme.accent, warning: theme.warning, track: withAlpha(theme.dark ? ink.white : ink.black, theme.dark ? VAULT_CODE.restTrack.dark : VAULT_CODE.restTrack.light) };
  const color = expiring ? ring.warning : ring.arc;
  const half = (rotateFrom: [number, number, number]) => ({
    position: "absolute" as const,
    width: size,
    height: size,
    borderRadius: capsule(size),
    borderWidth: stroke,
    borderTopColor: color,
    borderRightColor: color,
    borderBottomColor: ink.clear,
    borderLeftColor: ink.clear,
    transform: [{ rotate: progress.interpolate({ inputRange: [0, 0.5, 1], outputRange: rotateFrom.map((d) => `${d}deg`) }) }],
  });
  const clip = { position: "absolute" as const, top: 0, width: size / 2, height: size, overflow: "hidden" as const };
  return (
    <View style={{ width: size, height: size }}>
      <View style={{ position: "absolute", width: size, height: size, borderRadius: capsule(size), borderWidth: stroke, borderColor: ring.track }} />
      <View style={{ ...clip, left: size / 2 }}>
        <Animated.View style={{ ...half([QUARTER, QUARTER + HALF_SPAN, QUARTER + HALF_SPAN]), left: -size / 2, opacity: progress.interpolate({ inputRange: [0, HALF_DRAINED, HALF_DRAINED + DRAINED_EDGE, 1], outputRange: [1, 1, 0, 0] }) }} />
      </View>
      <View style={{ ...clip, left: 0 }}>
        <Animated.View style={{ ...half([QUARTER + HALF_SPAN, QUARTER + HALF_SPAN, QUARTER + 2 * HALF_SPAN]), left: 0 }} />
      </View>
    </View>
  );
}

const HALF_DRAINED = 0.5;
const DRAINED_EDGE = 0.001;
const COPY_GLYPH = { width: iconButton.m.box, height: iconButton.m.box } as const;
