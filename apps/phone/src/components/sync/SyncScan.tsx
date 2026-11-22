import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cameraErrorAccess, makeScanJudge, openCameraSettings, prepareCamera, type CameraAccess } from "../../state/sync/scan";
import { haptics } from "../../state/app/haptics";
import { SCAN_REJECTED } from "../../state/sync/syncRules";
import { copy } from "../../lib/platformCopy";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { controlRadius, CodeCamera, font, ink, Portal, scanInk, scanLayout, space, Symbol, tabsMotion, useTheme } from "../ui";
import { t } from "../../lib/uiLanguage";


const CAMERA_STOP_MS = 120;

type Props = { onScan: (phrase: string) => void; onEnterWords: () => void; onCancel: () => void; inline?: boolean };

export function SyncScan({ onScan, onEnterWords, onCancel, inline = false }: Props) {
  const insets = useSafeAreaInsets();
  const [access, setAccess] = useState<CameraAccess | "checking">("checking");
  const [rejected, setRejected] = useState(false);
  const judge = useRef(makeScanJudge()).current;
  const done = useRef(false);
  const [leaving, setLeaving] = useState(false);
  const leave = (then: () => void) => {
    if (leaving) return;
    setLeaving(true);
    setTimeout(then, CAMERA_STOP_MS);
  };
  useEffect(() => {
    void prepareCamera().then(setAccess);
  }, []);
  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      leave(onCancel);
      return true;
    });
    return () => back.remove();
  }, [onCancel, leaving]);
  const read = (text: string) => {
    if (done.current) return;
    const verdict = judge(text);
    if (verdict.kind === "accept") {
      done.current = true;
      const phrase = verdict.phrase;
      leave(() => onScan(phrase));
    } else if (verdict.kind === "reject") {
      haptics.error();
      setRejected(true);
    }
  };
  const screen = (
      <View testID="syncScanner" style={styles.screen}>
        {access === "checking" ? <ActivityIndicator style={styles.center} color={ink.white} /> : null}
        {access === "granted" ? (
          <>
            <CodeCamera
              onCode={read}
              onRejected={() => setRejected(true)}
              onError={(error) => setAccess(cameraErrorAccess(error))}
              active={!leaving}
            />
            <View style={[styles.finder, { paddingTop: insets.top + 44, paddingBottom: insets.bottom + space.xl }]}>
              <View style={styles.words}>
                <Text accessibilityRole="header" style={[font.title3, styles.bold, styles.white]}>
                  Scan the Code on Your Mac
                </Text>
                <Text style={[font.subheadline, styles.soft]}>In Ardia on your Mac, open Settings › Sync › Connect Another Device.</Text>
              </View>
              <FinderCorners />
              {rejected ? (
                <Animated.Text testID="scanRejected" entering={FadeIn.duration(tabsMotion.fade)} exiting={FadeOut.duration(tabsMotion.fade)} style={[font.subheadline, styles.medium, styles.white, styles.rejected]}>
                  {SCAN_REJECTED}
                </Animated.Text>
              ) : (
                <View />
              )}
              <GlassButton title={t(`Enter Words Instead`)} onPress={() => leave(onEnterWords)} />
            </View>
          </>
        ) : null}
        {access === "denied" ? (
          <Unavailable
            icon="gearshape"
            title={t(`Allow Camera Access`)}
            message={t(`Ardia uses the camera only to read the code your Mac shows. You can allow it in Settings, or type the 24 words instead.`)}
            onSettings={openCameraSettings}
            onEnterWords={onEnterWords}
          />
        ) : null}
        {access === "unavailable" || access === "undetermined" ? (
          <Unavailable
            icon="qrcodeViewfinder"
            title={copy().cantScanTitle}
            message={t(`Type the 24 words of your recovery phrase instead. Your Mac shows them under Connect Another Device.`)}
            onEnterWords={onEnterWords}
          />
        ) : null}
        <Pressable accessibilityRole="button" onPress={() => leave(onCancel)} style={[styles.cancel, { top: insets.top + space.xs }]}>
          <Text style={[font.body, styles.white]}>Cancel</Text>
        </Pressable>
      </View>
  );
  return inline ? screen : <Portal>{screen}</Portal>;
}

function FinderCorners() {
  const side = scanLayout.frame;
  const arm = side * scanLayout.frameArmShare;
  const inset = scanLayout.frameStroke / 2;
  const far = side - inset;
  const path = [
    `M${inset} ${inset + arm}L${inset} ${inset}L${inset + arm} ${inset}`,
    `M${far - arm} ${inset}L${far} ${inset}L${far} ${inset + arm}`,
    `M${inset} ${far - arm}L${inset} ${far}L${inset + arm} ${far}`,
    `M${far - arm} ${far}L${far} ${far}L${far} ${far - arm}`,
  ].join("");
  return (
    <Svg testID="scanFinder" width={side} height={side} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Path d={path} stroke={scanInk.frame} strokeWidth={scanLayout.frameStroke} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

function Unavailable({ icon, title, message, onSettings, onEnterWords }: { icon: "gearshape" | "qrcodeViewfinder"; title: string; message: string; onSettings?: () => void; onEnterWords: () => void }) {
  return (
    <View style={styles.unavailable}>
      <Symbol name={icon} size={48} color={scanInk.unavailableIcon} />
      <Text style={[font.title3, styles.bold, styles.white, styles.centered]}>{title}</Text>
      <Text style={[font.subheadline, styles.soft]}>{message}</Text>
      {onSettings ? <GlassButton title={t(`Open Settings`)} prominent onPress={onSettings} /> : null}
      <GlassButton title={t(`Enter Words Instead`)} onPress={onEnterWords} />
    </View>
  );
}

function GlassButton({ title, onPress, prominent }: { title: string; onPress: () => void; prominent?: boolean }) {
  const theme = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[styles.glass, { backgroundColor: prominent ? ink.white : scanInk.glass }]}>
      <Text style={[font.body, styles.bold, { color: prominent ? theme.label : ink.white }]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { ...StyleSheet.absoluteFill, backgroundColor: ink.black },
  center: { ...StyleSheet.absoluteFill },
  finder: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "space-between" },
  words: { alignItems: "center", gap: space.xs, paddingHorizontal: space.xxl },
  rejected: { backgroundColor: scanInk.note, borderRadius: scanLayout.noteRadius, paddingHorizontal: space.l, paddingVertical: space.s, overflow: "hidden" },
  unavailable: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.m, paddingHorizontal: space.xxl },
  glass: { minHeight: 50, borderRadius: controlRadius(50), borderCurve: "continuous", paddingHorizontal: space.xl, justifyContent: "center" },
  cancel: { position: "absolute", left: space.s, minHeight: 44, justifyContent: "center", paddingHorizontal: space.s },
  bold: { fontWeight: "600" },
  medium: { fontWeight: "500" },
  white: { color: ink.white },
  soft: { color: scanInk.soft, textAlign: "center" },
  centered: { textAlign: "center" },
});
