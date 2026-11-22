import { Text } from "react-native";
import { Dot, hairline, ink, Symbol, weight } from "../ui";
import { profileAccent } from "../ui/theme";
import { typeFace } from "../ui/tokens";
import type { Profile } from "../../state/browser/types";
import { profileBadge, profileColors, profileSwitcher } from "./tokens";
import { iconSymbol } from "../../lib/customIcon";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { snappedToDevicePixels } from "../../state/settings/interfaceScale";
import { CapCenteredLetter, inkCentered, InkHolder } from "../glyph/CapCenteredLetter";
import { t } from "../../lib/uiLanguage";


export const PROFILE_SYMBOLS: { name: string; title: string }[] = [
  { name: "house.fill", title: t(`Home`) },
  { name: "briefcase.fill", title: t(`Work`) },
  { name: "graduationcap.fill", title: t(`School`) },
  { name: "chevron.left.forwardslash.chevron.right", title: t(`Code`) },
  { name: "paintpalette.fill", title: t(`Art`) },
  { name: "hammer.fill", title: t(`Projects`) },
  { name: "book.closed.fill", title: t(`Reading`) },
  { name: "music.note", title: t(`Music`) },
  { name: "camera.fill", title: t(`Photos`) },
  { name: "gamecontroller.fill", title: t(`Games`) },
  { name: "cart.fill", title: t(`Shopping`) },
  { name: "banknote.fill", title: t(`Finance`) },
  { name: "airplane", title: t(`Travel`) },
  { name: "figure.run", title: t(`Fitness`) },
  { name: "cup.and.saucer.fill", title: t(`Café`) },
  { name: "leaf.fill", title: t(`Nature`) },
  { name: "pawprint.fill", title: t(`Pets`) },
  { name: "heart.fill", title: t(`Personal`) },
  { name: "star.fill", title: t(`Favorites`) },
  { name: "moon.stars.fill", title: t(`Evenings`) },
  { name: "person.fill", title: t(`Me`) },
  { name: "person.2.fill", title: t(`Family`) },
  { name: "building.2.fill", title: t(`Office`) },
  { name: "terminal.fill", title: t(`Terminal`) },
  { name: "server.rack", title: t(`Servers`) },
  { name: "flask.fill", title: t(`Lab`) },
  { name: "lightbulb.fill", title: t(`Ideas`) },
  { name: "sparkles", title: t(`Side Projects`) },
  { name: "newspaper.fill", title: t(`News`) },
  { name: "film.fill", title: t(`Movies`) },
  { name: "headphones", title: t(`Podcasts`) },
  { name: "sportscourt.fill", title: t(`Sports`) },
  { name: "bicycle", title: t(`Cycling`) },
  { name: "fork.knife", title: t(`Food`) },
  { name: "gift.fill", title: t(`Gifts`) },
  { name: "stethoscope", title: t(`Health`) },
  { name: "chart.line.uptrend.xyaxis", title: t(`Stocks`) },
  { name: "envelope.fill", title: t(`Mail`) },
  { name: "bubble.left.and.bubble.right.fill", title: t(`Chat`) },
  { name: "calendar", title: t(`Calendar`) },
  { name: "mountain.2.fill", title: t(`Outdoors`) },
  { name: "beach.umbrella.fill", title: t(`Holiday`) },
  { name: "lock.fill", title: t(`Private`) },
  { name: "flame.fill", title: t(`Hot`) },
  { name: "bolt.fill", title: t(`Energy`) },
];

export const switcherCellWidth = (icon: string | null) => (icon ? profileSwitcher.iconCell : profileSwitcher.dotCell);

export function switcherIcons(icons: (string | null)[], room: number): (string | null)[] {
  const fits = icons.reduce((width, icon) => width + switcherCellWidth(icon), 0) <= room;
  return fits ? icons : icons.map(() => null);
}

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

export function ProfileBadge({ profile, size = 26 }: { profile: Pick<Profile, "name" | "color" | "icon"> & Partial<Pick<Profile, "theme">>; size?: number }) {
  const swatch = profileAccent(profile);
  const symbol = iconSymbol(profile.icon);
  return (
    <Dot size={size} color={swatch} ring={badgeEdge(size) ? profileColors.badgeEdge : undefined} ringWidth={hairline.ring}>
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
