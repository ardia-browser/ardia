import { useEffect, useState, type ReactNode } from "react";
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, { Easing, FadeIn, FadeInLeft, FadeInRight, FadeOut, FadeOutLeft, FadeOutRight, useAnimatedStyle, useSharedValue, withDelay, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { advanceOnboarding, finishOnboarding, useOnboarding } from "../../state/onboarding/hooks";
import { refreshSettings, setBlockingCategory, useBlocking } from "../../state/settings/actions";
import { AppIcon, appIconLayout, LookBackdrop, moveTo, onboardingArt, font, primaryButtonHeight, radius, settingsTint, shadowRadius, smoothCorners, space, spring, Symbol, tabsMotion, ToggleTrack, useTheme, type SymbolName, useReduceMotion } from "../ui";
import type { Motion } from "../ui/motion";
import { useDesign } from "../ui";
import { useMaterialRipple } from "../ui/MaterialSurfaces";
import { useMaterialTheme } from "../ui/materialTheme";
import { materialEasing, materialMotion, materialShape, materialSize, materialType } from "../ui/materialTokens";
import { CrossfadeText, Divider, ToggleRow } from "../settings/SettingsKit";
import { SyncConnect } from "../sync/SyncConnect";
import { DefaultBrowserSteps } from "../settings/DefaultBrowserPage";
import { LinkBubble } from "./LinkBubble";
import { SyncScanIllustration } from "./SyncScanIllustration";
import { onboardingInk, onboardingLayout, onboardingMotion } from "./onboardingTokens";
import { PHONE_SHARING_COPY } from "../../lib/telemetryCopy";
import { setUsageSharing, useUsageSharing } from "../../state/telemetry/telemetry";
import { useSyncConnected } from "../../state/sync/hooks";
import { t } from "../../lib/uiLanguage";


const ONBOARDING_MIN_PAGE = 560;
const PRESSED_OPACITY = 0.82;
export const SYNC_SUBTITLE = { offer: t(`Your Mac’s tabs, right here. End-to-end encrypted.`), connected: t(`Your Mac’s tabs are here, end-to-end encrypted.`) } as const;
const LARGE_TEXT = 1.35;
export const ONBOARDING_LAYERS = { stepsBackdrop: 0, welcomeBackdrop: 1, step: 2 } as const;
const smooth = spring(0.42, 0.9);

export const stepIn = (direction: 1 | -1, reduced: boolean) => () => {
  "worklet";
  const motion = reduced ? onboardingMotion.stepReduced : onboardingMotion.step;
  const shift = reduced ? 0 : direction * onboardingMotion.stepTravel;
  return {
    initialValues: { opacity: 0, transform: [{ translateX: shift }] },
    animations: { opacity: moveTo(1, motion), transform: [{ translateX: moveTo(0, motion) }] },
  };
};

export const stepOut = (direction: 1 | -1, reduced: boolean) => () => {
  "worklet";
  const motion = reduced ? onboardingMotion.stepReduced : onboardingMotion.step;
  const shift = reduced ? 0 : -direction * onboardingMotion.stepTravel;
  return {
    initialValues: { opacity: 1, transform: [{ translateX: 0 }] },
    animations: { opacity: moveTo(0, motion), transform: [{ translateX: moveTo(shift, motion) }] },
  };
};

const fade = (from: number, to: number, motion: Motion) => () => {
  "worklet";
  return { initialValues: { opacity: from }, animations: { opacity: moveTo(to, motion) } };
};

const backdropIn = (reduced: boolean) => fade(0, 1, reduced ? onboardingMotion.backdropReduced : onboardingMotion.backdrop);
const backdropOut = (reduced: boolean) => fade(1, 0, reduced ? onboardingMotion.backdropReduced : onboardingMotion.backdrop);

const axisIn = Easing.bezier(...materialEasing[materialMotion.sharedAxisIn.easing]);
const axisOut = Easing.bezier(...materialEasing[materialMotion.sharedAxisOut.easing]);
const MATERIAL_STEP = {
  inForward: FadeInRight.duration(materialMotion.sharedAxisIn.durationMs).easing(axisIn),
  inBack: FadeInLeft.duration(materialMotion.sharedAxisIn.durationMs).easing(axisIn),
  outForward: FadeOutLeft.duration(materialMotion.sharedAxisOut.durationMs).easing(axisOut),
  outBack: FadeOutRight.duration(materialMotion.sharedAxisOut.durationMs).easing(axisOut),
};

const REDUCED_IN = FadeIn.duration(tabsMotion.fade);
const REDUCED_OUT = FadeOut.duration(tabsMotion.fade);

const slideUp = (height: number) => () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ translateY: height }] },
    animations: { opacity: withSpring(1, smooth), transform: [{ translateY: withSpring(0, smooth) }] },
  };
};

const slideDown = (height: number) => () => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ translateY: 0 }] },
    animations: { opacity: withSpring(0, smooth), transform: [{ translateY: withSpring(height, smooth) }] },
  };
};

export function OnboardingView() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const showing = useOnboarding((s) => s.showing);
  const step = useOnboarding((s) => s.step);
  const forward = useOnboarding((s) => s.forward);
  const reduceMotion = useReduceMotion();
  const { fontScale } = useWindowDimensions();
  const material = useDesign() === "material";
  useEffect(() => {
    if (showing) void refreshSettings();
  }, [showing]);
  useEffect(() => Keyboard.dismiss(), [step]);
  if (!showing) return null;
  const welcome = step === "welcome";
  const ink = theme.dark ? onboardingInk.dark : onboardingInk.light;
  const content = step === "welcome" ? <Welcome /> : step === "blocking" ? <Blocking /> : step === "sync" ? <SyncStep /> : step === "defaultBrowser" ? <DefaultBrowserStep /> : <AllSet />;
  return (
    <Animated.View exiting={FadeOut.duration(tabsMotion.surfaceFade)} style={[StyleSheet.absoluteFill, { backgroundColor: material ? theme.surface : ink.steps }]}>
      <Animated.View key={welcome ? "welcomeBackdrop" : "stepsBackdrop"} entering={backdropIn(reduceMotion)} exiting={backdropOut(reduceMotion)} style={[StyleSheet.absoluteFill, { zIndex: welcome ? ONBOARDING_LAYERS.welcomeBackdrop : ONBOARDING_LAYERS.stepsBackdrop }, material ? null : { backgroundColor: welcome ? ink.welcome : ink.steps }]}>
        {material ? <LookBackdrop softened={!welcome} fadesOut={!welcome} /> : null}
      </Animated.View>
      <Animated.View
        key={step}
        testID="onboardingStep"
        entering={material && !reduceMotion ? (forward ? MATERIAL_STEP.inForward : MATERIAL_STEP.inBack) : stepIn(forward ? 1 : -1, reduceMotion)}
        exiting={material && !reduceMotion ? (forward ? MATERIAL_STEP.outForward : MATERIAL_STEP.outBack) : stepOut(forward ? 1 : -1, reduceMotion)}
        style={[StyleSheet.absoluteFill, { zIndex: ONBOARDING_LAYERS.step, paddingTop: insets.top, paddingBottom: insets.bottom }]}
      >
        {fontScale > LARGE_TEXT ? (
          <ScrollView contentContainerStyle={styles.scrolled} keyboardShouldPersistTaps="handled">
            {content}
          </ScrollView>
        ) : (
          content
        )}
      </Animated.View>
    </Animated.View>
  );
}

function DefaultBrowserStep() {
  const theme = useTheme();
  return (
    <View style={styles.fill}>
      <View style={[styles.fill, styles.art]}>
        <LinkBubble />
      </View>
      <View style={[styles.browserSheet, { backgroundColor: theme.groupFill, shadowColor: theme.trayShadow }]}>
        <DefaultBrowserSteps onLater={advanceOnboarding} onDone={advanceOnboarding} />
      </View>
    </View>
  );
}

function SyncStep() {
  const theme = useTheme();
  const connected = useSyncConnected();
  const [connecting, setConnecting] = useState(false);
  const reduceMotion = useReduceMotion();
  const { height } = useWindowDimensions();
  return (
    <>
      <Page
        title={
          <>
            Every tab, <Text style={{ color: theme.spaceAccentInk }}>anywhere</Text>.
          </>
        }
        subtitle={connected ? SYNC_SUBTITLE.connected : SYNC_SUBTITLE.offer}
        illustration={
          <View style={styles.sketch}>
            <SyncScanIllustration connected={connected} />
          </View>
        }
      >
        {connected ? (
          <Primary title={t(`Continue`)} onPress={advanceOnboarding} />
        ) : (
          <>
            <Primary title={t(`Connect to Your Mac`)} onPress={() => setConnecting(true)} />
            <Secondary title={t(`Not Now`)} onPress={advanceOnboarding} />
          </>
        )}
      </Page>
      {connecting ? (
        <Animated.View testID="onboardingConnect" entering={reduceMotion ? REDUCED_IN : slideUp(height)} exiting={reduceMotion ? REDUCED_OUT : slideDown(height)} style={StyleSheet.absoluteFill}>
          <SyncConnect closes onClose={() => setConnecting(false)} onConnected={() => setConnecting(false)} />
        </Animated.View>
      ) : null}
    </>
  );
}

function Secondary({ title, onPress }: { title: string; onPress: () => void }) {
  const theme = useTheme();
  const { scheme } = useMaterialTheme();
  const ripple = useMaterialRipple();
  if (useDesign() === "material")
    return (
      <Pressable testID="materialOnboardingSecondary" accessibilityRole="button" android_ripple={ripple} onPress={onPress} style={styles.materialSecondary}>
        <Text style={[materialType.labelLarge, { color: scheme.primary }]}>{title}</Text>
      </Pressable>
    );
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.secondary}>
      <Text style={[font.body, styles.bold, { color: theme.spaceAccentInk }]}>{title}</Text>
    </Pressable>
  );
}

function Primary({ title, onPress }: { title: string; onPress: () => void }) {
  const theme = useTheme();
  const { scheme } = useMaterialTheme();
  const ripple = useMaterialRipple();
  if (useDesign() === "material")
    return (
      <Pressable testID="materialOnboardingPrimary" accessibilityRole="button" android_ripple={ripple} onPress={onPress} style={[styles.materialPrimary, { backgroundColor: scheme.primary }]}>
        <Text style={[materialType.titleMedium, styles.centeredText, { color: scheme.onPrimary }]}>{title}</Text>
      </Pressable>
    );
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.primary, { minHeight: primaryButtonHeight(), borderRadius: onboardingLayout.buttonRadius, backgroundColor: theme.spaceAccent, opacity: pressed ? PRESSED_OPACITY : 1 }]}
    >
      <Text style={[font.body, styles.primaryLabel, { color: theme.onSpaceAccent }]}>{title}</Text>
    </Pressable>
  );
}

function Welcome() {
  const theme = useTheme();
  const material = useDesign() === "material";
  const reduceMotion = useReduceMotion();
  const appear = useSharedValue(0);
  useEffect(() => {
    appear.value = reduceMotion ? moveTo(1, onboardingMotion.riseReduced) : withDelay(onboardingMotion.riseDelayMs, moveTo(1, onboardingMotion.rise));
  }, [appear]);
  const logo = useAnimatedStyle(
    () => ({
      opacity: Math.min(Math.max(appear.value, 0), 1),
      transform: [{ rotate: `${reduceMotion ? -6 : -18 + 12 * appear.value}deg` }, { scale: reduceMotion ? 1 : 0.7 + 0.3 * appear.value }],
    }),
    [reduceMotion],
  );
  const words = useAnimatedStyle(
    () => ({ opacity: Math.min(Math.max(appear.value, 0), 1), transform: [{ translateY: reduceMotion ? 0 : (1 - appear.value) * 16 }] }),
    [reduceMotion],
  );
  const start = useAnimatedStyle(() => ({ opacity: Math.min(Math.max(appear.value, 0), 1) }));
  return (
    <View style={[styles.fill, { gap: onboardingLayout.welcomeGap }]}>
      <View style={styles.fill} />
      <Animated.View testID="welcomeIcon" style={[styles.logo, logo]}>
        <AppIcon side={appIconLayout.welcome} scalesWithText={false} />
      </Animated.View>
      <Animated.View testID="welcomeWords" style={[styles.welcomeWords, words]}>
        <Text accessibilityRole="header" style={material ? [materialType.displaySmall, styles.centeredText, { color: theme.label }] : [onboardingLayout.welcomeTitle, styles.heavy, { color: theme.label }]}>
          Meet your new favorite browser
        </Text>
        <Text style={[material ? materialType.bodyLarge : onboardingLayout.welcomeSubtitle, styles.centered, { color: material ? theme.secondaryLabel : (theme.dark ? onboardingInk.dark : onboardingInk.light).subtitle }]}>Get what you want twice as fast.</Text>
      </Animated.View>
      <View style={styles.fill} />
      <Animated.View testID="onboardingActions" style={[styles.actions, { paddingTop: onboardingLayout.welcomeActionsTop }, start]}>
        <Primary title={t(`Get Started`)} onPress={advanceOnboarding} />
      </Animated.View>
    </View>
  );
}

function Page({ title, subtitle, illustration, sitsLow, hero, children }: { title: ReactNode; subtitle: string; illustration: ReactNode; sitsLow?: boolean; hero?: SymbolName; children: ReactNode }) {
  const theme = useTheme();
  const material = useDesign() === "material";
  const subtitleInk = material ? theme.secondaryLabel : (theme.dark ? onboardingInk.dark : onboardingInk.light).subtitle;
  return (
    <View style={styles.fill}>
      <View testID="onboardingIllustration" style={[styles.illustration, { justifyContent: sitsLow && material ? "flex-end" : "center" }]}>
        {hero && !material ? <HeroTile symbol={hero} /> : null}
        {illustration}
      </View>
      <View testID="onboardingWords" style={styles.words}>
        <Text accessibilityRole="header" style={material ? [materialType.headlineMedium, styles.centeredText, { color: theme.label }] : [onboardingLayout.title, styles.heavy, { color: theme.label }]}>
          {title}
        </Text>
        <CrossfadeText testID="onboardingSubtitle" text={subtitle} style={[material ? materialType.bodyLarge : font.body, styles.centered, { color: subtitleInk }]} />
      </View>
      <View testID="onboardingActions" style={[styles.actions, { paddingTop: onboardingLayout.actionsTop }]}>
        {children}
      </View>
    </View>
  );
}

function HeroTile({ symbol }: { symbol: SymbolName }) {
  const theme = useTheme();
  return (
    <View testID="onboardingHero" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.hero, { backgroundColor: theme.spaceAccentWash }]}>
      <Symbol name={symbol} size={onboardingLayout.heroGlyph} color={theme.spaceAccentInk} />
    </View>
  );
}

function OnboardingCard({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const { scheme } = useMaterialTheme();
  const style = useDesign() === "material"
    ? [styles.materialCard, { backgroundColor: scheme.surfaceContainerHigh }]
    : onboardingLayout.rowIcons
    ? [styles.card, { backgroundColor: theme.groupFill, shadowColor: theme.trayShadow }]
    : [styles.plainCard, { backgroundColor: theme.groupFill, boxShadow: theme.dark ? undefined : onboardingLayout.cardShadow }];
  return (
    <View testID="onboardingCard" style={style}>
      {children}
    </View>
  );
}

function PlainToggleRow({ title, value, divider, onChange }: { title: string; value: boolean; divider?: boolean; onChange: (on: boolean) => void }) {
  const theme = useTheme();
  return (
    <View>
      <Pressable accessibilityRole="switch" accessibilityLabel={title} accessibilityState={{ checked: value }} onPress={() => onChange(!value)} style={styles.plainRow}>
        <Text importantForAccessibility="no" accessibilityElementsHidden style={[font.body, styles.fill, { color: theme.label }]}>
          {title}
        </Text>
        <ToggleTrack value={value} />
      </Pressable>
      {divider ? <Divider inset={onboardingLayout.rowInset} /> : null}
    </View>
  );
}

const BLOCKING_ROWS = [
  { key: "ads", title: t(`Block Ads`), icon: "handRaised", tint: settingsTint.ads },
  { key: "trackers", title: t(`Block Trackers`), icon: "eyeglasses", tint: settingsTint.trackers },
  { key: "cookieBanners", title: t(`Block Cookie Banners`), icon: "listBulletFill", tint: settingsTint.cookies },
] as const;

function Blocking() {
  const theme = useTheme();
  const state = useBlocking((s) => s.state);
  const values = { ads: state?.blocksAds ?? true, trackers: state?.blocksTrackers ?? true, cookieBanners: state?.hidesCookieBanners ?? true };
  return (
    <Page
      title={
        <>
          Never see another <Text style={{ color: theme.spaceAccentInk }}>ad</Text>.
        </>
      }
      subtitle={t(`Trackers and cookie banners too.`)}
      sitsLow
      hero="handRaised"
      illustration={
        <OnboardingCard>
          {BLOCKING_ROWS.map((row, index) => {
            const divider = index < BLOCKING_ROWS.length - 1;
            const change = (on: boolean) => setBlockingCategory(row.key, on);
            return onboardingLayout.rowIcons ? (
              <ToggleRow key={row.key} title={row.title} icon={row.icon} tint={row.tint} value={values[row.key]} divider={divider} onChange={change} />
            ) : (
              <PlainToggleRow key={row.key} title={row.title} value={values[row.key]} divider={divider} onChange={change} />
            );
          })}
        </OnboardingCard>
      }
    >
      <Primary title={t(`Continue`)} onPress={advanceOnboarding} />
    </Page>
  );
}

const TIPS: { icon: SymbolName; text: string }[] = [
  { icon: "plus", text: t(`Tap + to search.`) },
  { icon: "squareOnSquare", text: t(`Flick a tab up to close it.`) },
  { icon: "handDrawFill", text: t(`Swipe a page to go back.`) },
  { icon: "archivebox", text: t(`Old tabs archive after a day.`) },
];

function AllSet() {
  const theme = useTheme();
  return (
    <Page
      title={t(`You’re all set!`)}
      subtitle={t(`Happy browsing.`)}
      sitsLow
      illustration={
        onboardingLayout.tipIcons ? (
          <Animated.View entering={FadeIn.duration(tabsMotion.surfaceFade)} style={[styles.card, styles.tips, { backgroundColor: theme.groupFill, shadowColor: theme.trayShadow }]}>
            {TIPS.map((tip) => (
              <View key={tip.text} style={styles.tip}>
                <View style={styles.tipIcon}>
                  <Symbol name={tip.icon} size={20} color={theme.spaceAccentInk} />
                </View>
                <Text style={[font.subheadline, { color: theme.label }]}>{tip.text}</Text>
              </View>
            ))}
          </Animated.View>
        ) : (
          <OnboardingCard>
            {TIPS.map((tip, index) => (
              <View key={tip.text}>
                <View style={styles.plainTip}>
                  <Text style={[font.body, { color: theme.label }]}>{tip.text}</Text>
                </View>
                {index < TIPS.length - 1 ? <Divider inset={onboardingLayout.rowInset} /> : null}
              </View>
            ))}
          </OnboardingCard>
        )
      }
    >
      <SharingChoice />
      <Primary title={t(`Start Browsing`)} onPress={finishOnboarding} />
    </Page>
  );
}

function SharingChoice() {
  const theme = useTheme();
  const sharing = useUsageSharing((s) => s.sharing);
  return (
    <View style={styles.sharing}>
      <View style={[styles.sharingCard, { backgroundColor: theme.groupFill }]}>
        <ToggleRow title={PHONE_SHARING_COPY.toggle} icon="checkmarkShield" tint={settingsTint.neutral} value={sharing} onChange={(on) => setUsageSharing(on, "onboarding")} />
      </View>
      <Text style={[font.footnote, styles.centered, { color: theme.dark ? onboardingInk.dark.subtitle : onboardingInk.light.subtitle }]}>{PHONE_SHARING_COPY.onboardingNote}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scrolled: { flexGrow: 1, minHeight: ONBOARDING_MIN_PAGE },
  sharing: { gap: space.s },
  sharingCard: { borderRadius: radius.card, overflow: "hidden", ...smoothCorners },
  fill: { flex: 1 },
  logo: {
    alignSelf: "center",
    marginBottom: onboardingLayout.welcomeIconBottom,
    padding: appIconLayout.welcomeFrame,
    borderRadius: appIconLayout.welcome * appIconLayout.corner + appIconLayout.welcomeFrame,
    backgroundColor: appIconLayout.fill,
    ...smoothCorners,
    boxShadow: appIconLayout.welcomeShadow,
  },
  hero: { alignSelf: "center", width: onboardingLayout.heroTile, height: onboardingLayout.heroTile, borderRadius: onboardingLayout.heroRadius, ...smoothCorners, alignItems: "center", justifyContent: "center", marginBottom: onboardingLayout.heroGap },
  sketch: { alignSelf: "center", transform: [{ scale: onboardingLayout.sketchScale }] },
  welcomeWords: { paddingHorizontal: onboardingLayout.wordsInset, gap: onboardingLayout.wordsGap, alignItems: "center" },
  words: { paddingTop: onboardingLayout.wordsTop, paddingHorizontal: onboardingLayout.wordsInset, gap: onboardingLayout.wordsGap, alignItems: "center" },
  heavy: { fontWeight: "700", textAlign: "center" },
  centered: { textAlign: "center" },
  bold: { fontWeight: "600" },
  actions: { paddingHorizontal: onboardingLayout.actionsInset, paddingBottom: onboardingLayout.actionsBottom, gap: onboardingLayout.actionsGap },
  primary: { alignItems: "center", justifyContent: "center", paddingHorizontal: space.l, paddingVertical: space.m, ...smoothCorners },
  materialPrimary: { minHeight: 56, borderRadius: materialShape.full, overflow: "hidden", alignItems: "center", justifyContent: "center", paddingHorizontal: 24 },
  materialSecondary: { minHeight: materialSize.touchTarget, borderRadius: materialShape.full, overflow: "hidden", alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  materialCard: { borderRadius: materialShape.medium, paddingVertical: 8, overflow: "hidden" },
  centeredText: { textAlign: "center" },
  primaryLabel: { fontWeight: "600", textAlign: "center" },
  illustration: { flex: 1, paddingHorizontal: onboardingLayout.illustrationInset },
  card: { borderRadius: radius.card, ...smoothCorners, paddingVertical: space.xs, elevation: 8, shadowOpacity: 0.4, shadowRadius: shadowRadius.card },
  plainCard: { borderRadius: onboardingLayout.cardRadius, borderCurve: "continuous", paddingVertical: onboardingLayout.cardInset },
  plainRow: { flexDirection: "row", alignItems: "center", gap: space.s, minHeight: onboardingLayout.rowHeight, paddingHorizontal: onboardingLayout.rowInset },
  plainTip: { minHeight: onboardingLayout.rowHeight, justifyContent: "center", paddingHorizontal: onboardingLayout.rowInset },
  art: { alignItems: "center", justifyContent: "center", paddingHorizontal: space.huge },
  browserSheet: {
    borderTopLeftRadius: onboardingArt.sheetRadius,
    borderTopRightRadius: onboardingArt.sheetRadius,
    paddingTop: space.huge - space.l,
    paddingBottom: space.m,
    elevation: 10,
    shadowOpacity: 0.08,
    shadowRadius: shadowRadius.card,
  },
  secondary: { minHeight: onboardingLayout.secondaryHeight, alignItems: "center", justifyContent: "center" },
  tips: { paddingHorizontal: space.xl, paddingVertical: space.xl, gap: space.xl },
  tip: { flexDirection: "row", alignItems: "center", gap: space.m },
  tipIcon: { width: 28, alignItems: "center" },
});
