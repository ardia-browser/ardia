import { useEffect, useRef, useState } from "react";
import { FlatList, Image, Pressable, StyleSheet, Text, View, type ViewInstance } from "react-native";
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown, useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from "react-native-reanimated";
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
import { dismissWords, ELLIPSIS } from "../../lib/sharedWords";
import { ChromeSurface, EmptyState, font, LoadingState, motionAliases, readerInk, readerLayout, smoothCorners, space, tabsMotion, TextSizeGlyph, useDesign, useModalOverlay, usePressStyle, useReduceMotion, type MenuItem } from "../ui";
import { MaterialIconAction, MaterialTopBar } from "../ui/MaterialTopBar";
import { MenuTrigger } from "../ui/MenuTrigger";
import { pageMenuOpener } from "./pageMenuOpener";
import { readerGlyphs } from "./readerTokens";

const rise = SlideInDown.springify().stiffness(tabsMotion.sheetIn.stiffness).damping(tabsMotion.sheetIn.damping);
const fall = SlideOutDown.springify().stiffness(tabsMotion.sheetOut.stiffness).damping(tabsMotion.sheetOut.damping);
const riseReduced = FadeIn.duration(tabsMotion.sheetReduced);
const fallReduced = FadeOut.duration(tabsMotion.sheetReduced);

export function useLeavingReader(tabId: string | null): { shown: string | null; closing: boolean } {
  const [shown, setShown] = useState(tabId);
  useEffect(() => {
    if (tabId !== shown) setShown(tabId);
  }, [tabId, shown]);
  return { shown: tabId ?? shown, closing: tabId === null && shown !== null };
}

type Load = { kind: "loading" } | { kind: "failed" } | { kind: "loaded"; content: ReadableContent };

export function ReaderView({ tabId, closing = false }: { tabId: string; closing?: boolean }) {
  const insets = useSafeAreaInsets();
  const material = useDesign() === "material";
  const reduceMotion = useReduceMotion();
  const done = useRef<ViewInstance>(null);
  const { ref: overlayRef, ...overlay } = useModalOverlay({ open: true, closing, onDismiss: closeReader, focus: material ? undefined : done, returnFocusTo: pageMenuOpener });
  const donePress = usePressStyle("text");
  const appearancePress = usePressStyle("icon");
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
    shownSize.value = reduceMotion ? size : withSpring(size, motionAliases.readerTextSize);
  }, [size, reduceMotion]);
  const family = settings.serif ? copy().readerSerif.family : copy().readerSans.family;
  const items: MenuItem[] = [
    { label: "Smaller Text", systemImage: "textformat.size.smaller", disabled: settings.step <= 0, onPress: () => setReaderStep(clampReaderStep(settings.step - 1)) },
    { label: "Larger Text", systemImage: "textformat.size.larger", disabled: settings.step >= READER_STEPS.length - 1, onPress: () => setReaderStep(clampReaderStep(settings.step + 1)) },
    "divider",
    { label: copy().readerSerif.label, checked: settings.serif, onPress: () => setReaderSerif(true) },
    { label: copy().readerSans.label, checked: !settings.serif, onPress: () => setReaderSerif(false) },
    "divider",
    ...(["light", "sepia", "dark"] as ReaderTheme[]).map((option) => ({
      label: option === "light" ? "Light" : option === "sepia" ? "Sepia" : "Dark",
      checked: option === shown,
      onPress: () => setReaderTheme(option),
    })),
  ];
  return (
    <Animated.View testID="readerView" entering={reduceMotion ? riseReduced : rise} exiting={reduceMotion ? fallReduced : fall} style={[StyleSheet.absoluteFill, { backgroundColor: ink.background }]}>
      <View testID="readerOverlay" ref={overlayRef} collapsable={false} style={[styles.fill, { paddingTop: insets.top }]} {...overlay}>
      {material ? (
        <MaterialTopBar
          nav="close"
          onNav={closeReader}
          ink={ink.ink}
          actions={
            load.kind === "loaded" ? (
              <MenuTrigger items={items} trigger="tap" fixedOrder frost={null} dark={shown === "dark"} place={{ top: insets.top + readerLayout.chromeBand, right: readerLayout.chromeSide }}>
                {({ onPress }) => <MaterialIconAction icon="textformatSize" label="Text Appearance" ink={ink.ink} onPress={onPress ?? (() => undefined)} />}
              </MenuTrigger>
            ) : null
          }
        />
      ) : (
      <View style={styles.top}>
        {load.kind === "loaded" ? (
          <MenuTrigger items={items} trigger="tap" fixedOrder frost={null} dark={shown === "dark"} place={{ top: insets.top + readerLayout.chromeBand, left: readerLayout.chromeSide }}>
            {({ onPress }) => (
              <Pressable accessibilityRole="button" accessibilityLabel="Text Appearance" onPress={onPress} style={appearancePress}>
                <ChromeSurface shape="circle" cornerRadius={readerLayout.chromeButton / 2} dark={shown === "dark"} style={styles.circle}>
                  <TextSizeGlyph size={readerGlyphs.textSize} color={ink.ink} />
                </ChromeSurface>
              </Pressable>
            )}
          </MenuTrigger>
        ) : null}
        <View style={styles.fill} />
        <Pressable ref={done} testID="readerDone" accessibilityRole="button" accessibilityLabel={dismissWords.done} onPress={closeReader} style={donePress}>
          <ChromeSurface shape="capsule" cornerRadius={readerLayout.chromeButton / 2} dark={shown === "dark"} style={styles.capsule}>
            <Text style={[font.body, styles.bold, { color: ink.ink }]}>{dismissWords.done}</Text>
          </ChromeSurface>
        </Pressable>
      </View>
      )}
      {load.kind === "loading" ? (
        <View style={styles.center}>
          <LoadingState testID="readerLoading" label={LOADING_ARTICLE} ink={{ label: ink.ink, secondary: ink.secondary }} />
        </View>
      ) : load.kind === "failed" ? (
        <View style={styles.center}>
          <EmptyState testID="readerNoArticle" title={NO_ARTICLE} glyph="docPlaintext" ink={{ label: ink.ink, secondary: ink.secondary }} />
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
      </View>
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
const NO_ARTICLE = "No Article Found";

const LOADING_ARTICLE = `Loading Article${ELLIPSIS}`;

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
  circle: { width: readerLayout.chromeButton, height: readerLayout.chromeButton, alignItems: "center", justifyContent: "center" },
  capsule: { height: readerLayout.chromeButton, paddingHorizontal: readerLayout.chromeCapsulePadding, alignItems: "center", justifyContent: "center" },
  fill: { flex: 1 },
  bold: { fontWeight: "600" },
  medium: { fontWeight: "500" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: { gap: space.s, paddingHorizontal: space.xl, paddingTop: space.s, maxWidth: readerLayout.maxWidth, alignSelf: "center", width: "100%" },
  paragraph: { paddingHorizontal: space.xl, maxWidth: readerLayout.maxWidth, alignSelf: "center", width: "100%" },
  lead: { width: "100%", marginTop: space.s, borderRadius: readerLayout.leadRadius, ...smoothCorners },
  navigationBand: { position: "absolute", left: 0, right: 0, bottom: 0 },
});
