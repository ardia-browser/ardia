import { useState, type ReactNode } from "react";
import { Text, View, type TextLayoutEvent, type ViewStyle } from "react-native";
import { Dot, hairline, ink, Symbol, weight } from "../ui";
import { profileAccent } from "../ui/theme";
import { typeFace } from "../ui/tokens";
import type { Profile } from "../../state/browser/types";
import { profileBadge, profileColors, profileSwitcher } from "./tokens";
import { iconSymbol } from "../../lib/customIcon";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { snappedToGrid } from "../../lib/interfaceScale";
import { currentInterfaceScale, snappedToDevicePixels } from "../../state/settings/interfaceScale";

export const PROFILE_SYMBOLS: { name: string; title: string }[] = [
  { name: "house.fill", title: "Home" },
  { name: "briefcase.fill", title: "Work" },
  { name: "graduationcap.fill", title: "School" },
  { name: "chevron.left.forwardslash.chevron.right", title: "Code" },
  { name: "paintpalette.fill", title: "Art" },
  { name: "hammer.fill", title: "Projects" },
  { name: "book.closed.fill", title: "Reading" },
  { name: "music.note", title: "Music" },
  { name: "camera.fill", title: "Photos" },
  { name: "gamecontroller.fill", title: "Games" },
  { name: "cart.fill", title: "Shopping" },
  { name: "banknote.fill", title: "Finance" },
  { name: "airplane", title: "Travel" },
  { name: "figure.run", title: "Fitness" },
  { name: "cup.and.saucer.fill", title: "Café" },
  { name: "leaf.fill", title: "Nature" },
  { name: "pawprint.fill", title: "Pets" },
  { name: "heart.fill", title: "Personal" },
  { name: "star.fill", title: "Favorites" },
  { name: "moon.stars.fill", title: "Evenings" },
  { name: "person.fill", title: "Me" },
  { name: "person.2.fill", title: "Family" },
  { name: "building.2.fill", title: "Office" },
  { name: "terminal.fill", title: "Terminal" },
  { name: "server.rack", title: "Servers" },
  { name: "flask.fill", title: "Lab" },
  { name: "lightbulb.fill", title: "Ideas" },
  { name: "sparkles", title: "Side Projects" },
  { name: "newspaper.fill", title: "News" },
  { name: "film.fill", title: "Movies" },
  { name: "headphones", title: "Podcasts" },
  { name: "sportscourt.fill", title: "Sports" },
  { name: "bicycle", title: "Cycling" },
  { name: "fork.knife", title: "Food" },
  { name: "gift.fill", title: "Gifts" },
  { name: "stethoscope", title: "Health" },
  { name: "chart.line.uptrend.xyaxis", title: "Stocks" },
  { name: "envelope.fill", title: "Mail" },
  { name: "bubble.left.and.bubble.right.fill", title: "Chat" },
  { name: "calendar", title: "Calendar" },
  { name: "mountain.2.fill", title: "Outdoors" },
  { name: "beach.umbrella.fill", title: "Holiday" },
  { name: "lock.fill", title: "Private" },
  { name: "flame.fill", title: "Hot" },
  { name: "bolt.fill", title: "Energy" },
];

export const switcherCellWidth = (icon: string | null) => (icon ? profileSwitcher.iconCell : profileSwitcher.dotCell);

export const switcherIconsWidth = (icons: (string | null)[]) => icons.reduce((width, icon) => width + switcherCellWidth(icon), 0);

export function SwitcherMark({ icon, color, scale = 1 }: { icon: string | null; color: string; scale?: number }) {
  const { iconCell, icon: size, dot } = profileSwitcher;
  const symbol = iconSymbol(icon);
  if (symbol) return <Symbol name={symbol} size={size * scale} weight="semibold" color={color} style={{ width: iconCell * scale, height: iconCell * scale }} />;
  if (icon)
    return (
      <Text numberOfLines={1} style={{ width: iconCell * scale, fontSize: size * scale, lineHeight: iconCell * scale, textAlign: "center", color }}>
        {icon}
      </Text>
    );
  return <Dot size={dot * scale} color={color} />;
}

const BADGE_EDGE_MIN = 22;

type LineMetrics = { ascender: number; capHeight: number };

const lineMetricsByFont = new Map<string, LineMetrics>();

function useLineMetrics(key: string) {
  const [, remeasured] = useState(0);
  const metrics = lineMetricsByFont.get(key);
  const onTextLayout = (e: TextLayoutEvent) => {
    const line = e.nativeEvent.lines[0];
    if (!line || (metrics?.ascender === line.ascender && metrics.capHeight === line.capHeight)) return;
    lineMetricsByFont.set(key, { ascender: line.ascender, capHeight: line.capHeight });
    remeasured((n) => n + 1);
  };
  return { metrics, onTextLayout };
}

const SYSTEM_FONT = { ascender: 0.9668, capHeight: 0.7046 } as const;

const EMOJI_FONT = { ascender: 0.9662, capHeight: 1 } as const;

const RETINA_PIXELS_PER_POINT = 2;

const retinaSnapped = (points: number) => snappedToGrid(points, RETINA_PIXELS_PER_POINT * currentInterfaceScale());

const badgeEdge = (size: number) => (size >= BADGE_EDGE_MIN ? hairline.ring : 0);

function inkCentered(size: number, shiftX: number, inkRise: number, metrics: LineMetrics) {
  const top = size / 2 - Math.round(metrics.ascender) + inkRise;
  return {
    position: "absolute" as const,
    left: -badgeEdge(size),
    top: Math.floor(top) - badgeEdge(size),
    width: size,
    transform: [{ translateX: retinaSnapped(shiftX) }, { translateY: retinaSnapped(top - Math.floor(top)) }],
  };
}

function glyphPlacement(size: number, emoji: boolean, fontSize: number, tracking: number, metrics: LineMetrics | undefined) {
  if (!PLATFORM_FEATURES.snapsTextBaselines) {
    const nudge = snappedToDevicePixels(size * profileBadge.nudge);
    return { holder: null, text: emoji ? { transform: [{ translateX: nudge }, { translateY: nudge }] } : { height: size, lineHeight: size, transform: [{ translateX: tracking / 2 }, { translateY: 0 }] } };
  }
  if (emoji) return { holder: inkCentered(size, EMOJI_FIT_BY_BADGE[size]?.shiftX ?? fontSize * profileBadge.emojiInkShift, fontSize * profileBadge.emojiInkRise, { ascender: fontSize * EMOJI_FONT.ascender, capHeight: fontSize * EMOJI_FONT.capHeight }), text: null };
  const line = metrics ?? { ascender: fontSize * SYSTEM_FONT.ascender, capHeight: fontSize * SYSTEM_FONT.capHeight };
  return { holder: inkCentered(size, tracking / 2, line.capHeight / 2, line), text: null };
}

const EMOJI_FIT_BY_BADGE: Partial<Record<number, { fontSize: number; shiftX?: number }>> = PLATFORM_FEATURES.snapsTextBaselines ? profileBadge.emojiFitByBadge : {};

function BadgeGlyph({ holder, children }: { holder: ViewStyle | null; children: ReactNode }) {
  return holder ? <View style={holder}>{children}</View> : <>{children}</>;
}

export function ProfileBadge({ profile, size = 26 }: { profile: Pick<Profile, "name" | "color" | "icon"> & Partial<Pick<Profile, "theme">>; size?: number }) {
  const swatch = profileAccent(profile);
  const symbol = iconSymbol(profile.icon);
  const emoji = !!profile.icon;
  const tracking = emoji ? 0 : size * profileBadge.initialTracking;
  const fontSize = emoji ? (EMOJI_FIT_BY_BADGE[size]?.fontSize ?? size * profileBadge.emojiScale) : size * profileBadge.initialScale;
  const line = useLineMetrics(`${typeFace().fontFamily ?? ""}|${emoji ? "emoji" : "initial"}|${fontSize}`);
  const placement = glyphPlacement(size, emoji, fontSize, tracking, line.metrics);
  return (
    <Dot size={size} color={swatch} ring={badgeEdge(size) ? profileColors.badgeEdge : undefined} ringWidth={hairline.ring}>
      {symbol ? (
        <Symbol name={symbol} size={size * 0.5} weight="semibold" color={ink.white} style={{ width: size, height: size }} />
      ) : (
        <BadgeGlyph holder={placement.holder}>
          <Text
            numberOfLines={1}
            onTextLayout={PLATFORM_FEATURES.snapsTextBaselines && !emoji ? line.onTextLayout : undefined}
            style={{
              ...typeFace(),
              width: size,
              textAlign: "center",
              fontSize,
              letterSpacing: tracking,
              fontWeight: weight.semibold,
              color: ink.white,
              ...placement.text,
            }}
          >
            {profile.icon ?? (profile.name.trim()[0] ?? "?").toUpperCase()}
          </Text>
        </BadgeGlyph>
      )}
    </Dot>
  );
}
