import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { SlideInDown, SlideOutDown, useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSystemBars } from "../../state/app/systemBars";
import { closeReader, readableContent, setReaderSerif, setReaderStep, setReaderTheme, type ReadableContent } from "../../state/page/actions";
import { useReaderSettings } from "../../state/page/hooks";
import { useDarkScheme } from "../../state/settings/appearance";
import {
  clampReaderStep,
  READER_STEPS,
  leadImageAspect,
  readerBodySize,
  readerSource,
  readerTheme,
  readingMinutes,
  type ReaderTheme,
} from "../../state/page/pagePrompts";
import { copy } from "../../lib/platformCopy";
import { ChromeSurface, font, readerInk, readerLayout, space, Symbol, tabsMotion, useDesign, type MenuItem } from "../ui";
import { MaterialIconAction, MaterialTopBar } from "../ui/MaterialTopBar";
import { MenuTrigger } from "../ui/MenuTrigger";
import { t } from "../../lib/uiLanguage";



const rise = SlideInDown.springify().stiffness(tabsMotion.sheetIn.stiffness).damping(tabsMotion.sheetIn.damping);
const fall = SlideOutDown.springify().stiffness(tabsMotion.sheetOut.stiffness).damping(tabsMotion.sheetOut.damping);

type Load = { kind: "loading" } | { kind: "failed" } | { kind: "loaded"; content: ReadableContent };

export function ReaderView({ tabId }: { tabId: string }) {
  const insets = useSafeAreaInsets();
  const material = useDesign() === "material";
  const dark = useDarkScheme();
  const settings = useReaderSettings();
  const shown = readerTheme(settings.theme, dark);
  const ink = readerInk[shown];
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  useSystemBars(shown === "dark");
  useEffect(() => {
    let live = true;
    void readableContent(tabId).then((content) => {
      if (live) setLoad(content && content.paragraphs.length ? { kind: "loaded", content } : { kind: "failed" });
    });
    return () => {
      live = false;
    };
  }, [tabId]);
  const size = readerBodySize(settings.step);
  const shownSize = useSharedValue(size);
  useEffect(() => {
    shownSize.value = withSpring(size, SIZE_SPRING);
  }, [size]);
  const family = settings.serif ? copy().readerSerif.family : copy().readerSans.family;
  const items: MenuItem[] = [
    { label: t(`Smaller Text`), systemImage: "textformat.size.smaller", disabled: settings.step <= 0, onPress: () => setReaderStep(clampReaderStep(settings.step - 1)) },
    { label: t(`Larger Text`), systemImage: "textformat.size.larger", disabled: settings.step >= READER_STEPS.length - 1, onPress: () => setReaderStep(clampReaderStep(settings.step + 1)) },
    "divider",
    { label: copy().readerSerif.label, checked: settings.serif, onPress: () => setReaderSerif(true) },
    { label: copy().readerSans.label, checked: !settings.serif, onPress: () => setReaderSerif(false) },
    "divider",
    ...(["light", "sepia", "dark"] as ReaderTheme[]).map((option) => ({
      label: option === "light" ? t(`Light`) : option === "sepia" ? t(`Sepia`) : t(`Dark`),
      checked: option === shown,
      onPress: () => setReaderTheme(option),
    })),
  ];
  return (
    <Animated.View entering={rise} exiting={fall} style={[StyleSheet.absoluteFill, { backgroundColor: ink.background, paddingTop: insets.top }]}>
      {material ? (
        <MaterialTopBar
          nav="close"
          onNav={closeReader}
          ink={ink.ink}
          actions={
            load.kind === "loaded" ? (
              <MenuTrigger items={items} trigger="tap" fixedOrder frost={null} dark={shown === "dark"} place={{ top: insets.top + readerLayout.chromeBand, right: readerLayout.chromeSide }}>
                {({ onPress }) => <MaterialIconAction icon="textformatSize" label={t(`Text Appearance`)} ink={ink.ink} onPress={onPress ?? (() => undefined)} />}
              </MenuTrigger>
            ) : null
          }
        />
      ) : (
      <View style={styles.top}>
        {load.kind === "loaded" ? (
          <MenuTrigger items={items} trigger="tap" fixedOrder frost={null} dark={shown === "dark"} place={{ top: insets.top + readerLayout.chromeBand, left: readerLayout.chromeSide }}>
            {({ onPress }) => (
              <Pressable accessibilityRole="button" accessibilityLabel={t(`Text Appearance`)} onPress={onPress}>
                <ChromeSurface shape="circle" cornerRadius={readerLayout.chromeButton / 2} dark={shown === "dark"} style={styles.circle}>
                  <View style={styles.mirrored}>
                    <Symbol name="textformatSize" size={30} color={ink.ink} />
                  </View>
                </ChromeSurface>
              </Pressable>
            )}
          </MenuTrigger>
        ) : null}
        <View style={styles.fill} />
        <Pressable accessibilityRole="button" onPress={closeReader}>
          <ChromeSurface shape="capsule" cornerRadius={readerLayout.chromeButton / 2} dark={shown === "dark"} style={styles.capsule}>
            <Text style={[font.body, styles.bold, { color: ink.ink }]}>Done</Text>
          </ChromeSurface>
        </Pressable>
      </View>
      )}
      {load.kind === "loading" ? (
        <View style={styles.center}>
          <ActivityIndicator accessibilityLabel={t(`Loading article`)} color={ink.secondary} />
        </View>
      ) : load.kind === "failed" ? (
        <View style={[styles.center, styles.gap]}>
          <Symbol name="docPlaintext" size={44} color={ink.secondary} />
          <Text style={[font.title3, styles.bold, { color: ink.ink }]}>No Article Found</Text>
        </View>
      ) : (
        <FlatList
          data={load.content.paragraphs}
          keyExtractor={(_, index) => String(index)}
          contentContainerStyle={{ paddingBottom: insets.bottom + space.huge }}
          ListHeaderComponent={<Header content={load.content} family={family} size={size} ink={ink} />}
          renderItem={({ item }) => <Paragraph text={item} family={family} size={shownSize} color={ink.ink} />}
        />
      )}
      <View style={[styles.navigationBand, { height: insets.bottom, backgroundColor: ink.background }]} pointerEvents="none" />
    </Animated.View>
  );
}

type Ink = (typeof readerInk)[ReaderTheme];

function Header({ content, family, size, ink }: { content: ReadableContent; family: string; size: number; ink: Ink }) {
  const source = readerSource(content.siteName, content.byline);
  const title = size * readerLayout.titleScale;
  return (
    <View style={[styles.header, { marginBottom: size * readerLayout.headerGap }]}>
      {source ? (
        <Text style={[font.subheadline, styles.medium, { color: ink.secondary }]} numberOfLines={2}>
          {source}
        </Text>
      ) : null}
      <Text selectable accessibilityRole="header" style={{ fontFamily: family, fontWeight: "700", fontSize: title, lineHeight: title * readerLayout.titleLine, color: ink.ink }}>
        {content.title}
      </Text>
      <Text style={[font.subheadline, { color: ink.secondary }]}>{`${readingMinutes(content.wordCount)} min read`}</Text>
      {content.leadImage && WEB_IMAGE.test(content.leadImage) ? <LeadImage uri={content.leadImage} /> : null}
    </View>
  );
}

function Paragraph({ text, family, size, color }: { text: string; family: string; size: SharedValue<number>; color: string }) {
  const sized = useAnimatedStyle(() => ({ fontSize: size.value, lineHeight: size.value * readerLayout.lineHeight, marginBottom: size.value * readerLayout.paragraphGap }));
  return (
    <Animated.Text selectable style={[styles.paragraph, { fontFamily: family, color }, sized]}>
      {text}
    </Animated.Text>
  );
}

const WEB_IMAGE = /^https?:\/\//i;
const SIZE_STIFFNESS = 1500;
const SIZE_SPRING = { stiffness: SIZE_STIFFNESS, damping: 2 * Math.sqrt(SIZE_STIFFNESS), mass: 1 };

function LeadImage({ uri }: { uri: string }) {
  const [aspect, setAspect] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    setAspect(null);
    Image.getSize(uri)
      .then(({ width, height }) => live && setAspect(leadImageAspect(width, height, readerLayout.minLeadAspect)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [uri]);
  if (!aspect) return null;
  return <Image source={{ uri }} accessibilityIgnoresInvertColors resizeMode="cover" onError={() => setAspect(null)} style={[styles.lead, { aspectRatio: aspect }]} />;
}

const styles = StyleSheet.create({
  top: { flexDirection: "row", alignItems: "center", minHeight: readerLayout.chromeBand, paddingHorizontal: readerLayout.chromeSide },
  mirrored: { transform: [{ scaleX: -1 }] },
  circle: { width: readerLayout.chromeButton, height: readerLayout.chromeButton, alignItems: "center", justifyContent: "center" },
  capsule: { height: readerLayout.chromeButton, paddingHorizontal: readerLayout.chromeCapsulePadding, alignItems: "center", justifyContent: "center" },
  fill: { flex: 1 },
  bold: { fontWeight: "600" },
  medium: { fontWeight: "500" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  gap: { gap: space.m },
  header: { gap: space.s, paddingHorizontal: space.xl, paddingTop: space.s, maxWidth: readerLayout.maxWidth, alignSelf: "center", width: "100%" },
  paragraph: { paddingHorizontal: space.xl, maxWidth: readerLayout.maxWidth, alignSelf: "center", width: "100%" },
  lead: { width: "100%", marginTop: space.s, borderRadius: readerLayout.leadRadius },
  navigationBand: { position: "absolute", left: 0, right: 0, bottom: 0 },
});
