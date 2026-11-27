import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import { tileGradient } from "../../lib/favicon";
import { linearGradientCss } from "../../lib/gradient";
import { capsule, smoothCorners, useReduceMotion } from "../ui";
import { blockingDemo, demoPage } from "./blockingDemoTokens";
import { PHONE_SCREEN } from "./PhoneFrame";

const INK = demoPage.ink;
const BANNER = demoPage.banner;
const INLINE = demoPage.inline;
const COOKIE = demoPage.cookie;
const HERO = demoPage.hero;
const HERO_WIDTH = PHONE_SCREEN.width - 2 * demoPage.pad;

type AdPresence = { banner: SharedValue<number>; inline: SharedValue<number>; cookie: SharedValue<number> };

const fraction = (value: number, from: number) => {
  "worklet";
  return Math.min(1, Math.max(0, (value - from) / (1 - from)));
};

export function BlockingScreen() {
  const reduceMotion = useReduceMotion();
  const [adsShown, setAdsShown] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setAdsShown((shown) => !shown), adsShown ? blockingDemo.clutteredMs : blockingDemo.cleanMs);
    return () => clearTimeout(timer);
  }, [adsShown]);

  return <View testID="blockingScreen" style={StyleSheet.absoluteFill}>{reduceMotion ? <FadingArticle adsShown={adsShown} /> : <CollapsingArticle adsShown={adsShown} />}</View>;
}

function CollapsingArticle({ adsShown }: { adsShown: boolean }) {
  const start = adsShown ? 1 : 0;
  const banner = useSharedValue(start);
  const inline = useSharedValue(start);
  const cookie = useSharedValue(start);

  useEffect(() => {
    const target = adsShown ? 1 : 0;
    const motion = adsShown ? blockingDemo.show : blockingDemo.hide;
    [banner, inline, cookie].forEach((presence, order) => {
      presence.value = withDelay(order * blockingDemo.staggerMs, withSpring(target, motion));
    });
  }, [adsShown, banner, inline, cookie]);

  return <Article presence={{ banner, inline, cookie }} />;
}

function FadingArticle({ adsShown }: { adsShown: boolean }) {
  const present = useSharedValue(1);
  const absent = useSharedValue(0);
  const clean = useSharedValue(adsShown ? 0 : 1);

  useEffect(() => {
    clean.value = withTiming(adsShown ? 0 : 1, { duration: blockingDemo.reducedFadeMs });
  }, [adsShown, clean]);

  const cluttered = useAnimatedStyle(() => ({ opacity: 1 - clean.value }));
  const tidy = useAnimatedStyle(() => ({ opacity: clean.value }));

  return (
    <>
      <Animated.View style={[StyleSheet.absoluteFill, cluttered]}>
        <Article presence={{ banner: present, inline: present, cookie: present }} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, tidy]}>
        <Article presence={{ banner: absent, inline: absent, cookie: absent }} />
      </Animated.View>
    </>
  );
}

function Article({ presence }: { presence: AdPresence }) {
  return (
    <View style={styles.paper}>
      <View style={styles.column}>
        <Collapsing presence={presence.banner} height={BANNER.height}>
          <BannerAd />
        </Collapsing>
        <Masthead />
        <SectionNav />
        <Text style={styles.kicker}>{demoPage.kicker.text}</Text>
        <Text style={styles.headline}>{demoPage.headline.text}</Text>
        <Text style={styles.byline}>{demoPage.byline.text}</Text>
        <Hero />
        <Paragraph widths={demoPage.paragraphs[0]!} />
        <Collapsing presence={presence.inline} height={INLINE.height}>
          <SponsoredAd />
        </Collapsing>
        {demoPage.paragraphs.slice(1).map((widths, index) => (
          <Paragraph key={index} widths={widths} />
        ))}
      </View>
      <CookieSheet presence={presence.cookie} />
    </View>
  );
}

function Collapsing({ presence, height, children }: { presence: SharedValue<number>; height: number; children: ReactNode }) {
  const style = useAnimatedStyle(() => {
    const shown = Math.max(0, presence.value);
    return {
      height: height * shown,
      marginBottom: demoPage.gap * Math.min(1, shown) - demoPage.gap,
      opacity: fraction(shown, blockingDemo.fadeLead),
      transform: [{ scale: blockingDemo.shrinkScale + (1 - blockingDemo.shrinkScale) * Math.min(1, shown) }],
    };
  }, [height]);
  return (
    <Animated.View style={[styles.collapsing, style]}>
      <View style={{ height }}>{children}</View>
    </Animated.View>
  );
}

function BannerAd() {
  return (
    <View style={[styles.banner, { experimental_backgroundImage: linearGradientCss(tileGradient(BANNER.tint), true, HERO_WIDTH, BANNER.height) }]}>
      <View style={styles.bannerWords}>
        <View style={styles.adTag}>
          <Text style={styles.adTagText}>{BANNER.tag}</Text>
        </View>
        <Text style={styles.bannerTitle} numberOfLines={1}>
          {BANNER.title}
        </Text>
        <Text style={styles.bannerDetail} numberOfLines={1}>
          {BANNER.detail}
        </Text>
      </View>
      <View style={styles.bannerCta}>
        <Text style={styles.bannerCtaText}>{BANNER.cta}</Text>
      </View>
      <View style={styles.close}>
        <Text style={styles.closeGlyph}>×</Text>
      </View>
    </View>
  );
}

function SponsoredAd() {
  return (
    <View style={styles.inline}>
      <View style={[styles.thumb, { experimental_backgroundImage: linearGradientCss(tileGradient(INLINE.thumb.tint), true, INLINE.thumb.side, INLINE.thumb.side) }]} />
      <View style={styles.inlineWords}>
        <Text style={styles.inlineLabel}>{INLINE.label}</Text>
        <Text style={styles.inlineTitle} numberOfLines={2}>
          {INLINE.title}
        </Text>
        <Text style={styles.inlineCta}>{INLINE.cta} ›</Text>
      </View>
    </View>
  );
}

function CookieSheet({ presence }: { presence: SharedValue<number> }) {
  const style = useAnimatedStyle(() => ({
    opacity: fraction(presence.value, blockingDemo.cookieFadeLead),
    transform: [{ translateY: (1 - Math.min(1, presence.value)) * (COOKIE.height + COOKIE.inset) }],
  }));
  return (
    <Animated.View style={[styles.cookie, style]}>
      <Text style={styles.cookieTitle}>{COOKIE.title}</Text>
      <Text style={styles.cookieDetail} numberOfLines={2}>
        {COOKIE.detail}
      </Text>
      <View style={styles.cookieButtons}>
        <View style={[styles.cookieButton, { backgroundColor: COOKIE.essentialFill }]}>
          <Text style={[styles.cookieButtonText, { color: INK.text }]}>{COOKIE.essential}</Text>
        </View>
        <View style={[styles.cookieButton, { backgroundColor: COOKIE.acceptFill }]}>
          <Text style={[styles.cookieButtonText, { color: INK.white }]}>{COOKIE.accept}</Text>
        </View>
      </View>
    </Animated.View>
  );
}

function Masthead() {
  const bars = demoPage.masthead.menuBar;
  return (
    <View style={styles.masthead}>
      <View style={[styles.menu, { gap: bars.gap }]}>
        {[0, 1, 2].map((bar) => (
          <View key={bar} style={styles.menuBar} />
        ))}
      </View>
      <Text style={styles.siteName} numberOfLines={1}>
        {demoPage.masthead.name}
      </Text>
      <View style={styles.search} />
    </View>
  );
}

function SectionNav() {
  const nav = demoPage.nav;
  return (
    <View style={styles.nav}>
      {nav.items.map((item, index) => (
        <Text key={item} style={[styles.navItem, index === nav.active ? styles.navActive : null]}>
          {item}
        </Text>
      ))}
    </View>
  );
}

function Hero() {
  return (
    <View style={[styles.hero, { experimental_backgroundImage: linearGradientCss(tileGradient(HERO.tint), false, HERO_WIDTH, HERO.height) }]}>
      <View style={styles.sun} />
      {HERO.peaks.map((peak, index) => (
        <View key={index} style={[styles.peak, { width: peak.side, height: peak.side, left: peak.left, top: peak.top, backgroundColor: peak.fill }]} />
      ))}
      <Text style={styles.heroCaption}>{HERO.caption.text}</Text>
    </View>
  );
}

function Paragraph({ widths }: { widths: readonly number[] }) {
  return (
    <View style={styles.paragraph}>
      {widths.map((share, index) => (
        <View key={index} style={[styles.bodyLine, { width: `${share * 100}%` }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  paper: { flex: 1, backgroundColor: INK.paper },
  column: { paddingTop: demoPage.top, paddingHorizontal: demoPage.pad, gap: demoPage.gap },
  collapsing: { overflow: "hidden", justifyContent: "center" },
  paragraph: { gap: demoPage.paragraphGap },
  bodyLine: { height: demoPage.bodyLine, borderRadius: demoPage.bodyLine / 2, backgroundColor: INK.line },
  masthead: { height: demoPage.masthead.height, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: INK.rule },
  menu: { width: demoPage.masthead.menuBar.width },
  menuBar: { height: demoPage.masthead.menuBar.height, borderRadius: demoPage.masthead.menuBar.height / 2, backgroundColor: INK.text },
  siteName: { fontFamily: demoPage.masthead.family, fontSize: demoPage.masthead.size, fontWeight: "700", color: INK.text },
  search: { width: demoPage.masthead.search.side, height: demoPage.masthead.search.side, borderRadius: demoPage.masthead.search.side / 2, borderWidth: demoPage.masthead.search.ring, borderColor: INK.text },
  nav: { height: demoPage.nav.height, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  navItem: { fontSize: demoPage.nav.size, fontWeight: "600", color: INK.muted },
  navActive: { color: INK.accent, textDecorationLine: "underline" },
  kicker: { fontSize: demoPage.kicker.size, fontWeight: "800", letterSpacing: demoPage.kicker.spacing, color: INK.accent, marginBottom: demoPage.kicker.pull },
  headline: { fontSize: demoPage.headline.size, lineHeight: demoPage.headline.lineHeight, fontWeight: demoPage.headline.weight, color: INK.text, marginBottom: demoPage.headline.pull },
  byline: { fontSize: demoPage.byline.size, color: INK.muted },
  hero: { height: HERO.height, borderRadius: HERO.radius, ...smoothCorners, overflow: "hidden" },
  sun: { position: "absolute", top: HERO.sun.top, right: HERO.sun.right, width: HERO.sun.side, height: HERO.sun.side, borderRadius: HERO.sun.side / 2, backgroundColor: HERO.sun.fill },
  peak: { position: "absolute", transform: [{ rotate: "45deg" }] },
  heroCaption: { position: "absolute", left: HERO.caption.left, bottom: HERO.caption.bottom, fontSize: HERO.caption.size, fontWeight: "600", color: INK.whiteSoft },
  banner: { flex: 1, borderRadius: BANNER.radius, ...smoothCorners, overflow: "hidden", flexDirection: "row", alignItems: "center", paddingLeft: BANNER.padLeft, paddingRight: BANNER.padRight, gap: demoPage.gap },
  bannerWords: { flex: 1, gap: BANNER.wordGap },
  adTag: { alignSelf: "flex-start", paddingHorizontal: BANNER.tagPad.x, paddingVertical: BANNER.tagPad.y, borderRadius: BANNER.tagRadius, backgroundColor: INK.tagFill, marginBottom: BANNER.wordGap },
  adTagText: { fontSize: BANNER.tagSize, fontWeight: "800", letterSpacing: BANNER.tagSpacing, color: INK.white },
  bannerTitle: { fontSize: BANNER.titleSize, fontWeight: "800", color: INK.white },
  bannerDetail: { fontSize: BANNER.detailSize, color: INK.whiteSoft },
  bannerCta: { height: BANNER.ctaHeight, paddingHorizontal: demoPage.gap, borderRadius: capsule(BANNER.ctaHeight), backgroundColor: INK.white, justifyContent: "center" },
  bannerCtaText: { fontSize: BANNER.ctaSize, fontWeight: "700", color: BANNER.tint },
  close: { position: "absolute", top: BANNER.close.inset, right: BANNER.close.inset, width: BANNER.close.side, height: BANNER.close.side, borderRadius: BANNER.close.side / 2, backgroundColor: INK.closeFill, alignItems: "center", justifyContent: "center" },
  closeGlyph: { fontSize: BANNER.close.glyph, lineHeight: BANNER.close.glyphLine, fontWeight: "600", color: INK.white },
  inline: { flex: 1, borderRadius: INLINE.radius, ...smoothCorners, backgroundColor: INLINE.fill, flexDirection: "row", alignItems: "center", padding: demoPage.gap, gap: demoPage.gap },
  thumb: { width: INLINE.thumb.side, height: INLINE.thumb.side, borderRadius: INLINE.thumb.radius, ...smoothCorners },
  inlineWords: { flex: 1, gap: INLINE.wordGap },
  inlineLabel: { fontSize: INLINE.labelSize, fontWeight: "700", letterSpacing: INLINE.labelSpacing, color: INK.muted, textTransform: "uppercase" },
  inlineTitle: { fontSize: INLINE.titleSize, lineHeight: INLINE.titleLine, fontWeight: "700", color: INK.text },
  inlineCta: { fontSize: INLINE.ctaSize, fontWeight: "700", color: INK.accent },
  cookie: {
    position: "absolute",
    left: COOKIE.inset,
    right: COOKIE.inset,
    bottom: COOKIE.inset,
    height: COOKIE.height,
    borderRadius: COOKIE.radius,
    ...smoothCorners,
    backgroundColor: COOKIE.fill,
    boxShadow: COOKIE.shadow,
    padding: demoPage.pad,
    gap: demoPage.paragraphGap,
  },
  cookieTitle: { fontSize: COOKIE.titleSize, fontWeight: "800", color: INK.text },
  cookieDetail: { fontSize: COOKIE.detailSize, lineHeight: COOKIE.detailLine, color: INK.muted },
  cookieButtons: { flexDirection: "row", gap: demoPage.gap, marginTop: "auto" },
  cookieButton: { flex: 1, height: COOKIE.buttonHeight, borderRadius: capsule(COOKIE.buttonHeight), alignItems: "center", justifyContent: "center" },
  cookieButtonText: { fontSize: COOKIE.buttonSize, fontWeight: "700" },
});
