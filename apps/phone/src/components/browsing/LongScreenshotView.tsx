import { useEffect, useRef, useState } from "react";
import { Image, StyleSheet, Text, useWindowDimensions, View, type AccessibilityActionEvent } from "react-native";
import { Gesture, GestureDetector, ScrollView } from "react-native-gesture-handler";
import Animated, { FadeIn, FadeOut, runOnJS } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { draggedCrop, minimumCropRows, wholeCrop, type Crop, type CropHandle, type Shot } from "../../lib/longScreenshot";
import { actionWords, dismissWords, ELLIPSIS } from "../../lib/sharedWords";
import { useSystemBars } from "../../state/app/systemBars";
import { cancelLongScreenshot, closeLongScreenshot, longScreenshotBack, saveLongScreenshot, shareLongScreenshot, useLongScreenshot, type LongScreenshotStage } from "../../state/longScreenshot/store";
import { ActionButton, font, iconRoles, LoadingState, longScreenshotInk, longScreenshotLayout, space, Symbol, tabsMotion, useModalOverlay, useReduceMotion, useTheme } from "../ui";
import { pageMenuOpener } from "./pageMenuOpener";

const CAPTURING = `Capturing Page${ELLIPSIS}`;
const SAVED = "Saved to Pictures › Ardia";
const CROP_HINT = "Drag the top and bottom edges to crop.";
const EDGE_LABELS: Record<CropHandle, string> = { top: "Top Edge", bottom: "Bottom Edge" };

const screensLabel = (screens: number) => (screens === 1 ? "1 screen" : `${screens} screens`);

export function LongScreenshotHost() {
  const stage = useLongScreenshot((state) => state.stage);
  if (stage.kind === "idle") return null;
  return <LongScreenshotView stage={stage} />;
}

function LongScreenshotView({ stage }: { stage: Exclude<LongScreenshotStage, { kind: "idle" }> }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const { ref, ...overlay } = useModalOverlay({ open: true, onDismiss: longScreenshotBack, returnFocusTo: pageMenuOpener });
  useSystemBars(theme.dark);
  const shot = stage.kind === "capturing" ? null : stage.shot;
  const [crop, setCrop] = useState<Crop | null>(shot ? wholeCrop(shot) : null);
  const shotId = shot?.id ?? null;
  useEffect(() => {
    setCrop(shot ? wholeCrop(shot) : null);
  }, [shotId]);
  const saving = stage.kind === "preview" && stage.saving;
  const saved = stage.kind === "saved";
  const fade = reduceMotion ? tabsMotion.sheetReduced : tabsMotion.surfaceFade;
  return (
    <Animated.View testID="longScreenshot" entering={FadeIn.duration(fade)} exiting={FadeOut.duration(fade)} style={[StyleSheet.absoluteFill, { backgroundColor: theme.groupedBackground }]}>
      <View ref={ref} collapsable={false} style={[styles.fill, { paddingTop: insets.top }]} {...overlay}>
        <View style={styles.bar}>
          <View style={styles.barSide}>
            {saved ? null : <ActionButton testID="longScreenshotCancel" title={dismissWords.cancel} variant="plain" tone="neutral" disabled={saving} onPress={cancelLongScreenshot} />}
          </View>
          <View style={styles.barTitle} accessible accessibilityRole="header">
            <Text style={[font.body, styles.bold, { color: theme.label }]} numberOfLines={1}>
              {actionWords.longScreenshot}
            </Text>
            {shot ? <Text style={[font.footnote, { color: theme.secondaryLabel }]}>{screensLabel(shot.screens)}</Text> : null}
          </View>
          <View style={[styles.barSide, styles.barEnd]}>
            {saved ? null : (
              <ActionButton testID="longScreenshotSave" title="Save" variant="plain" tone="accent" busy={saving} disabled={!shot || !crop} onPress={() => (crop ? void saveLongScreenshot(crop) : undefined)} />
            )}
          </View>
        </View>
        {shot && crop ? (
          <ShotPreview shot={shot} crop={crop} onCrop={setCrop} locked={saving || saved} bottomInset={insets.bottom} />
        ) : (
          <View style={styles.center}>
            <LoadingState testID="longScreenshotCapturing" label={CAPTURING} />
          </View>
        )}
        {stage.kind === "saved" ? <SavedPanel sharing={stage.sharing} bottomInset={insets.bottom} /> : null}
      </View>
    </Animated.View>
  );
}

function SavedPanel({ sharing, bottomInset }: { sharing: boolean; bottomInset: number }) {
  const theme = useTheme();
  return (
    <Animated.View testID="longScreenshotSaved" entering={FadeIn.duration(tabsMotion.surfaceFade)} style={[styles.panel, { backgroundColor: theme.groupedCell, paddingBottom: bottomInset + space.l, borderTopColor: theme.divider }]}>
      <View style={styles.savedLine} accessible accessibilityLiveRegion="polite" accessibilityLabel={SAVED}>
        <Symbol name="checkmarkCircle" size={20} color={theme.spaceAccentInk} />
        <Text style={[font.callout, styles.bold, { color: theme.label }]}>{SAVED}</Text>
      </View>
      <View style={styles.panelButtons}>
        <View style={styles.fill}>
          <ActionButton testID="longScreenshotShare" title={actionWords.share} icon={iconRoles.share} variant="filled" tone="accent" busy={sharing} stretch onPress={() => void shareLongScreenshot()} />
        </View>
        <View style={styles.fill}>
          <ActionButton testID="longScreenshotDone" title={dismissWords.done} variant="filled" tone="neutral" stretch onPress={closeLongScreenshot} />
        </View>
      </View>
    </Animated.View>
  );
}

function ShotPreview({ shot, crop, onCrop, locked, bottomInset }: { shot: Shot; crop: Crop; onCrop: (crop: Crop) => void; locked: boolean; bottomInset: number }) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const shown = Math.max(1, width - longScreenshotLayout.side * 2);
  const scale = shown / shot.width;
  const least = minimumCropRows(shot, scale, longScreenshotLayout.leastCrop);
  const [dragging, setDragging] = useState(false);
  const top = crop.top * scale;
  const bottom = crop.bottom * scale;
  const tall = shot.height * scale;
  return (
    <ScrollView testID="longScreenshotScroll" style={styles.fill} scrollEnabled={!dragging} bounces={false} overScrollMode="never" contentContainerStyle={{ alignItems: "center", paddingTop: longScreenshotLayout.handleHit / 2 + space.s, paddingBottom: bottomInset + space.huge * 4 }}>
      <View style={[styles.frame, { width: shown, height: tall, borderColor: longScreenshotInk.frame }]} accessibilityLabel={`${actionWords.longScreenshot}, ${screensLabel(shot.screens)}`}>
        {shot.tiles.map((tile) => (
          <Image key={tile.uri} source={{ uri: tile.uri }} resizeMethod="resize" fadeDuration={0} style={{ width: shown, height: tile.height * scale }} />
        ))}
        <View pointerEvents="none" style={[styles.shade, { top: 0, height: top }]} />
        <View pointerEvents="none" style={[styles.shade, { top: bottom, height: Math.max(0, tall - bottom) }]} />
        {locked ? null : (
          <>
            <CropEdge handle="top" at={top} shot={shot} crop={crop} scale={scale} least={least} onCrop={onCrop} onDragging={setDragging} />
            <CropEdge handle="bottom" at={bottom} shot={shot} crop={crop} scale={scale} least={least} onCrop={onCrop} onDragging={setDragging} />
          </>
        )}
      </View>
      {locked ? null : <Text style={[font.footnote, styles.hint, { color: theme.secondaryLabel }]}>{CROP_HINT}</Text>}
    </ScrollView>
  );
}

function CropEdge({ handle, at, shot, crop, scale, least, onCrop, onDragging }: { handle: CropHandle; at: number; shot: Shot; crop: Crop; scale: number; least: number; onCrop: (crop: Crop) => void; onDragging: (dragging: boolean) => void }) {
  const start = useRef(crop);
  const latest = useRef(crop);
  latest.current = crop;
  const began = () => {
    start.current = latest.current;
    onDragging(true);
  };
  const moved = (travel: number) => onCrop(draggedCrop(shot, start.current, handle, travel, scale, least));
  const ended = () => onDragging(false);
  const pan = Gesture.Pan()
    .minDistance(1)
    .onBegin(() => {
      runOnJS(began)();
    })
    .onUpdate((event) => {
      runOnJS(moved)(event.translationY);
    })
    .onFinalize(() => {
      runOnJS(ended)();
    });
  const nudge = (direction: 1 | -1) => onCrop(draggedCrop(shot, latest.current, handle, direction * shot.height * longScreenshotLayout.nudgeShare * scale, scale, least));
  const onAccessibilityAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === "increment") nudge(1);
    if (event.nativeEvent.actionName === "decrement") nudge(-1);
  };
  const theme = useTheme();
  const handleInk = { backgroundColor: theme.spaceAccent };
  const percent = Math.round(((handle === "top" ? crop.top : crop.bottom) / shot.height) * 100);
  return (
    <GestureDetector gesture={pan}>
      <View
        testID={handle === "top" ? "longScreenshotTopEdge" : "longScreenshotBottomEdge"}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={EDGE_LABELS[handle]}
        accessibilityValue={{ text: `${percent}%` }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={onAccessibilityAction}
        hitSlop={{ left: longScreenshotLayout.side, right: longScreenshotLayout.side }}
        style={[styles.edge, { top: at - longScreenshotLayout.handleHit / 2 }]}
      >
        <View style={[styles.edgeLine, handleInk]} />
        <View style={[styles.grip, handleInk]} />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bold: { fontWeight: "600" },
  bar: { height: longScreenshotLayout.bar, flexDirection: "row", alignItems: "center", paddingHorizontal: space.s },
  barSide: { flex: 1, flexDirection: "row" },
  barEnd: { justifyContent: "flex-end" },
  barTitle: { flex: 2, alignItems: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  frame: { overflow: "visible", borderWidth: StyleSheet.hairlineWidth },
  shade: { position: "absolute", left: 0, right: 0, backgroundColor: longScreenshotInk.shade },
  edge: { position: "absolute", left: -space.s, right: -space.s, height: longScreenshotLayout.handleHit, alignItems: "center", justifyContent: "center" },
  edgeLine: { position: "absolute", left: 0, right: 0, height: longScreenshotLayout.handleLine, borderRadius: longScreenshotLayout.handleLine / 2, borderWidth: StyleSheet.hairlineWidth, borderColor: longScreenshotInk.handleEdge },
  grip: { width: longScreenshotLayout.grip.width, height: longScreenshotLayout.grip.height, borderRadius: longScreenshotLayout.grip.height / 2, borderWidth: 2, borderColor: longScreenshotInk.handleEdge },
  hint: { marginTop: space.m, textAlign: "center", paddingHorizontal: longScreenshotLayout.side },
  panel: { position: "absolute", left: 0, right: 0, bottom: 0, paddingTop: space.l, paddingHorizontal: space.l, gap: longScreenshotLayout.panelGap, borderTopWidth: StyleSheet.hairlineWidth },
  savedLine: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.s },
  panelButtons: { flexDirection: "row", gap: space.m },
});
