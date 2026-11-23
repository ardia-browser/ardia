import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { badgeFrameOf, badgeGlyphOf, badgePressCounts, badgeShownFor, type BadgeArea, type BadgeFrame, type BadgeGlyph, type BadgeInk } from "../../state/vaults/fieldBadge";
import { noteVaultMenuPress, useVaultMenus } from "../../state/vaults/menu";
import { pressFieldProviderKey, useFieldProviderFillOfTab } from "../../state/site/passwordManager";
import { useVaultMenuGlass } from "../../state/vaults/hooks";
import { noteVaultMenuOpenFromIcon } from "../../state/telemetry/vaultCounts";
import { useSettings, useTabLive } from "../../state/browser/hooks";
import { parseColor, toHex } from "../../lib/color";
import { isBrandColor, readableBrand } from "../../state/vaults/highlight";
import { curve, GlassFill, ink, liquidGlass, Panel, reduceMotion, shadow, Symbol, useHover, useTheme } from "../ui";
import { VAULT_FIELD_BADGE, VAULT_MENU } from "./tokens";

const hexWithAlpha = (color: string, alpha: number) => {
  const [r, g, b] = parseColor(color);
  return toHex([r, g, b, alpha * 255]);
};

export function VaultFieldBadgeHost({ tabId, zoom }: { tabId: string; zoom: number }) {
  const [area, setArea] = useState<BadgeArea>({ width: 0, height: 0 });
  const field = useVaultMenus((s) => s.fields[tabId] ?? null);
  const fill = useFieldProviderFillOfTab(tabId);
  const open = useVaultMenus((s) => {
    const menu = s.menus[tabId];
    const now = s.fields[tabId];
    return !!menu && !!now && !menu.hidden && menu.frameId === now.frameId && menu.field === now.kind;
  });
  const extendWebsiteColor = useSettings((s) => s.extendWebsiteColor);
  const glyph = badgeGlyphOf(field?.kind);
  const frame = glyph && field && badgeShownFor(field, fill !== null) ? badgeFrameOf(glyph, field.rect, zoom, area, !!field.rtl, field.inset) : null;
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill} onLayout={(e) => setArea(e.nativeEvent.layout)}>
      {frame && glyph && field ? (
        <Badge key={field.at} tabId={tabId} frame={frame} glyph={glyph} open={open} pageDark={field.darkField ?? null} brand={extendWebsiteColor ? field.brandColor ?? null : null} onToggle={() => pressBadge(() => pressFieldProviderKey(tabId) === "opened")} />
      ) : null}
    </View>
  );
}

function useEased(on: boolean, ms: number) {
  const value = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => {
    if (reduceMotion() === true) return value.setValue(on ? 1 : 0);
    const run = Animated.timing(value, { toValue: on ? 1 : 0, duration: ms, easing: curve.enter, useNativeDriver: true });
    run.start();
    return () => run.stop();
  }, [on]);
  return value;
}

function useFadeIn() {
  const appear = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const run = Animated.timing(appear, { toValue: 1, duration: VAULT_FIELD_BADGE.fadeInMs, easing: curve.enter, useNativeDriver: true });
    run.start();
    return () => run.stop();
  }, []);
  return appear;
}

let lastPressAt = -Infinity;

export function pressBadge(toggle: () => boolean) {
  const now = Date.now();
  if (!badgePressCounts(now, lastPressAt)) return;
  lastPressAt = now;
  if (toggle()) noteVaultMenuOpenFromIcon();
}

const imageBox = (at: BadgeInk) => ({ position: "absolute", left: at.imageX, top: at.imageY, width: at.imageWidth, height: at.imageHeight }) as const;
const inkPivot = (at: BadgeInk): [number, number, number] => [at.x + at.width / 2 - at.imageX, at.y + at.height / 2 - at.imageY, 0];

export function Badge({ tabId, frame, glyph, open, pageDark, brand = null, onToggle }: { tabId: string; frame: BadgeFrame; glyph: BadgeGlyph; open: boolean; pageDark: boolean | null; brand?: string | null; onToggle: () => void }) {
  const theme = useTheme();
  const dark = pageDark ?? theme.dark;
  const { hovered, hoverProps } = useHover();
  const [pressed, setPressed] = useState(false);
  const glass = useVaultMenuGlass() && liquidGlass;
  const appear = useFadeIn();
  const press = useEased(pressed, VAULT_FIELD_BADGE.pressMs);
  const still = reduceMotion() === true;
  const lit = hovered || pressed;
  const tone = dark ? ink.white : ink.black;
  const shownBrand = brand && isBrandColor(brand, dark ? ink.black : ink.white) ? readableBrand(brand) : null;
  const openFill = shownBrand ? shownBrand.fill : theme.accent;
  const openInk = shownBrand?.onLight ? ink.black : ink.white;
  const glyphInk = open ? openInk : hexWithAlpha(tone, lit ? VAULT_FIELD_BADGE.inkAlpha.lit : VAULT_FIELD_BADGE.inkAlpha.rest);
  const solidTint = dark ? VAULT_FIELD_BADGE.solid.tint.dark : VAULT_FIELD_BADGE.solid.tint.light;
  const glassFill = VAULT_FIELD_BADGE.glass.fill;
  const restFill = glass ? (dark ? (lit ? glassFill.darkLit : glassFill.dark) : lit ? glassFill.lightLit : glassFill.light) : hexWithAlpha(tone, lit ? solidTint.lit : solidTint.rest);
  const plate = open ? openFill : lit ? restFill : ink.clear;
  const edge = !glass || open || !lit ? ink.clear : dark ? VAULT_FIELD_BADGE.glass.edge.dark : VAULT_FIELD_BADGE.glass.edge.light;
  const scale = press.interpolate({ inputRange: [0, 1], outputRange: [1, VAULT_FIELD_BADGE.pressScale] });
  const lifted = glass && !open && lit;
  return (
    <Animated.View
      style={{
        position: "absolute",
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        opacity: appear,
        transform: still ? [] : [{ scale }],
      }}
    >
      <Pressable
        {...hoverProps}
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={glyph.label}
        accessibilityState={{ expanded: open }}
        onPressIn={() => {
          noteVaultMenuPress();
          setPressed(true);
        }}
        onPressOut={() => setPressed(false)}
        onPress={onToggle}
        style={{ flex: 1, borderRadius: VAULT_FIELD_BADGE.radius, cursor: "pointer" }}
      >
        <Panel pointerEvents="none" style={StyleSheet.absoluteFill} radius={VAULT_FIELD_BADGE.radius} fill={lifted ? ink.clear : plate} border={lifted ? edge : ink.clear} shadow={{ ...shadow.tooltip, opacity: lifted ? shadow.tooltip.opacity[dark ? "dark" : "light"] : 0 }}>
          {lifted ? <GlassFill radius={VAULT_FIELD_BADGE.radius} dark={dark} state={pressed ? "pressed" : hovered ? "lit" : "rest"} /> : null}
          {lifted ? <View style={{ ...StyleSheet.absoluteFillObject, borderRadius: VAULT_FIELD_BADGE.radius, backgroundColor: plate }} /> : null}
        </Panel>
        <View pointerEvents="none" style={{ ...imageBox(frame.glyph), transformOrigin: inkPivot(frame.glyph), transform: frame.glyph.name.startsWith("key") ? [{ scaleX: -1 }] : [] }}>
          <Symbol name={frame.glyph.name} size={frame.glyph.size} weight="medium" color={glyphInk} style={FILL} />
        </View>
        {frame.plus ? (
<Symbol name={frame.plus.name} size={frame.plus.size} weight="bold" color={glyphInk} style={imageBox(frame.plus)} />
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

const FILL = { flex: 1 } as const;
