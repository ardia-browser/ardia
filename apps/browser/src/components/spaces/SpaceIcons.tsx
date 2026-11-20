import type { IconMenuItem } from "../../state/spaces/spaceMenu";
import { useState, type ReactNode } from "react";
import { Text, View, type TextLayoutEvent, type ViewStyle } from "react-native";
import { Dot, hairline, ink, Symbol, weight } from "../ui";
import { spaceAccent } from "../ui/theme";
import { typeFace } from "../ui/tokens";
import type { Space } from "../../state/browser/types";
import { profileBadge, spaceColors, spaceSwitcher } from "./tokens";
import { iconSymbol, symbolIcon } from "../../lib/customIcon";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { snappedToDevicePixels } from "../../state/settings/interfaceScale";
import { CapCenteredLetter, inkCentered, InkHolder } from "../glyph/CapCenteredLetter";

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

const EMOJI = ["😀", "😎", "🤓", "🧑‍💻", "💼", "🏠", "🎓", "🎨", "🎮", "🎵", "📚", "✈️", "🌱", "🔥", "⭐️", "🚀", "🐶", "🐱", "🦊", "🍀"];

export function iconMenuItems(current: string | null, noneTitle = "Initial"): IconMenuItem[] {
  return [
    { value: { icon: null }, title: noneTitle, checked: !current },
    { separator: true },
    ...PROFILE_SYMBOLS.map((s) => ({ value: { icon: symbolIcon(s.name) }, title: s.title, symbol: s.name, checked: current === symbolIcon(s.name) })),
    { separator: true },
    {
      id: "emoji",
      title: "Emoji",
      checked: !!current && !iconSymbol(current),
      children: EMOJI.map((e) => ({ value: { icon: e }, title: e, checked: current === e })),
    },
  ];
}

export const switcherCellWidth = (icon: string | null) => (icon ? spaceSwitcher.iconCell : spaceSwitcher.dotCell);

export function switcherIcons(icons: (string | null)[], shown: boolean, room: number): (string | null)[] {
  const fits = icons.reduce((width, icon) => width + switcherCellWidth(icon), 0) <= room;
  return shown && fits ? icons : icons.map(() => null);
}

export function SwitcherMark({ icon, color, scale = 1 }: { icon: string | null; color: string; scale?: number }) {
  const { iconCell, icon: size, dot } = spaceSwitcher;
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

const EMOJI_FONT = { ascender: 0.9662, capHeight: 1 } as const;

const badgeEdge = (size: number) => (size >= BADGE_EDGE_MIN ? hairline.ring : 0);

function emojiPlacement(size: number, fontSize: number) {
  if (!PLATFORM_FEATURES.snapsTextBaselines) {
    const nudge = snappedToDevicePixels(size * profileBadge.nudge);
    return { holder: null, text: { transform: [{ translateX: nudge }, { translateY: nudge }] } };
  }
  const shiftX = EMOJI_FIT_BY_BADGE[size]?.shiftX ?? fontSize * profileBadge.emojiInkShift;
  return { holder: inkCentered(size, shiftX, fontSize * profileBadge.emojiInkRise, { ascender: fontSize * EMOJI_FONT.ascender, capHeight: fontSize * EMOJI_FONT.capHeight }, badgeEdge(size)), text: null };
}

const EMOJI_FIT_BY_BADGE: Partial<Record<number, { fontSize: number; shiftX?: number }>> = PLATFORM_FEATURES.snapsTextBaselines ? profileBadge.emojiFitByBadge : {};

function BadgeGlyph({ holder, children }: { holder: ViewStyle | null; children: ReactNode }) {
  return holder ? <View style={holder}>{children}</View> : <>{children}</>;
}

export function SpaceBadge({ profile, size = 26 }: { profile: Pick<Space, "name" | "color" | "icon"> & Partial<Pick<Space, "theme">>; size?: number }) {
  const swatch = spaceAccent(profile);
  const symbol = iconSymbol(profile.icon);
  return (
    <Dot size={size} color={swatch} ring={badgeEdge(size) ? spaceColors.badgeEdge : undefined} ringWidth={hairline.ring}>
      {symbol ? (
        <Symbol name={symbol} size={size * 0.5} weight="semibold" color={ink.white} style={{ width: size, height: size }} />
      ) : profile.icon ? (
        <BadgeEmoji emoji={profile.icon} size={size} />
      ) : (
        <CapCenteredLetter box={size} inset={badgeEdge(size)} fontSize={size * profileBadge.initialScale} tracking={size * profileBadge.initialTracking} fontWeight={weight.semibold} color={ink.white}>
          {(profile.name.trim()[0] ?? "?").toUpperCase()}
        </CapCenteredLetter>
      )}
    </Dot>
  );
}

function BadgeEmoji({ emoji, size }: { emoji: string; size: number }) {
  const fontSize = EMOJI_FIT_BY_BADGE[size]?.fontSize ?? size * profileBadge.emojiScale;
  const placement = emojiPlacement(size, fontSize);
  return (
    <InkHolder style={placement.holder}>
      <Text numberOfLines={1} style={{ ...typeFace(), width: size, textAlign: "center", fontSize, fontWeight: weight.semibold, color: ink.white, ...placement.text }}>
        {emoji}
      </Text>
    </InkHolder>
  );
}
