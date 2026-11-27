import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { newIncognitoTab, newRegularTab, newTab, openArchive, openSpaces, reopenLastClosed, showDeck } from "../../state/browse/store";
import { useSearchOpen } from "../../state/search/hooks";
import { openSettings } from "../../state/settings/hooks";
import { useSyncEnabled } from "../../state/sync/hooks";
import { useCanReopen, useHasTabs, useIncognito } from "../../state/tabs/hooks";
import { useMaterialBarRegistration } from "../browsing/PersistentMaterialBar";
import { ArdiaLogo, Backdrop, browseLayout, MaterialIconButton, useReduceMotion, useTheme, type SymbolName } from "../ui";
import { MaterialBottomBar } from "../ui/MaterialBottomBar";
import { useMaterialTheme } from "../ui/materialTheme";
import { materialBottomBar, materialDuration, materialMotion, materialMove, materialSize, materialType } from "../ui/materialTokens";
import { StartMark } from "./StartSpaces";
import { reducedMotionMs } from "../ui/motion";
import type { MaterialScheme } from "../../lib/material/schemes";
import { actionWords, destinationWords } from "../../lib/sharedWords";
import { dotBesideGlyph, NoticeDot, withUpdateWords } from "../settings/UpdateDot";
import { useUpdateDot } from "../../state/appUpdate/store";

export const materialStartMs = (reduceMotion: boolean, searching: boolean) =>
  reduceMotion ? reducedMotionMs(materialDuration.short3) : searching ? materialMotion.fadeThroughOut.durationMs : materialMotion.fadeThroughIn.durationMs;

export function MaterialStart() {
  const incognito = useIncognito();
  const { scheme } = useMaterialTheme(incognito);
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const updateDot = useUpdateDot();
  const searching = useSearchOpen();
  const hasTabs = useHasTabs();
  const canReopen = useCanReopen();
  const syncs = useSyncEnabled();
  const reduceMotion = useReduceMotion();
  const shown = useSharedValue(searching ? 0 : 1);
  useEffect(() => {
    shown.value = materialMove(searching ? 0 : 1, searching ? materialMotion.fadeThroughOut.easing : materialMotion.fadeThroughIn.easing, materialStartMs(reduceMotion, searching));
  }, [searching, reduceMotion]);
  const fade = useAnimatedStyle(() => ({ opacity: shown.value }));
  const hosted = useMaterialBarRegistration("start", {
    bar: { isStart: true, scheme, incognito, onSearch: newTab, container: { style: !hasTabs ? styles.emptyBar : null } },
  });
  const side = Math.max(insets.left, insets.right) + materialBottomBar.edge;
  const ink = scheme.onSurface;
  const leading: { icon: SymbolName; label: string; onPress: () => void } = hasTabs
    ? { icon: "squareOnSquare", label: "Tabs", onPress: showDeck }
    : syncs
      ? { icon: "laptop", label: destinationWords.spaces, onPress: openSpaces }
      : { icon: "archivebox", label: destinationWords.archive, onPress: openArchive };
  return (
    <View testID="materialStart" style={StyleSheet.absoluteFill}>
      {incognito ? <View testID="materialStartBackdrop" style={[StyleSheet.absoluteFill, { backgroundColor: scheme.surface }]} /> : <Backdrop colors={theme.start.colors} />}
      <Animated.View
        testID="materialStartTopBar"
        pointerEvents={searching ? "none" : "box-none"}
        collapsable={false}
        importantForAccessibility={searching ? "no-hide-descendants" : "auto"}
        accessibilityElementsHidden={searching}
        style={[styles.topBar, { paddingTop: insets.top, paddingLeft: insets.left + 4, paddingRight: insets.right + 4 }, fade]}
      >
        <StartIconButton icon={leading.icon} label={leading.label} scheme={scheme} onPress={leading.onPress} />
        <View style={styles.fill} />
        {incognito ? (
          <StartIconButton icon="plus" label={actionWords.newTab} scheme={scheme} onPress={newRegularTab} />
        ) : (
          <StartIconButton icon="eyes" label={actionWords.newIncognitoTab} scheme={scheme} onPress={newIncognitoTab} />
        )}
        {canReopen && !incognito ? <StartIconButton icon="arrowUturnBackward" label="Reopen Closed Tab" scheme={scheme} onPress={reopenLastClosed} /> : null}
        <StartIconButton icon="gearshape" label={destinationWords.settings} scheme={scheme} dot={updateDot} onPress={() => openSettings()} />
      </Animated.View>
      <Animated.View
        testID="materialStartCenter"
        pointerEvents={hasTabs || searching ? "none" : "box-none"}
        collapsable={false}
        importantForAccessibility={searching ? "no-hide-descendants" : "auto"}
        accessibilityElementsHidden={searching}
        style={[styles.center, { paddingLeft: side, paddingRight: side }, fade]}
      >
        <View pointerEvents="box-none" style={styles.logo}>
          {hasTabs ? <ArdiaLogo width={browseLayout.logoWidth} /> : <StartMark incognito={incognito} />}
          {incognito ? <Text style={[materialType.titleMedium, { color: ink }]}>You’re browsing Incognito</Text> : null}
        </View>
      </Animated.View>
      {hosted ? null : (
        <MaterialBottomBar
          isStart
          scheme={scheme}
          incognito={incognito}
          onSearch={newTab}
          container={{
            testID: "materialStartBottomBar",
            pointerEvents: searching ? "none" : "auto",
            collapsable: false,
            importantForAccessibility: searching ? "no-hide-descendants" : "auto",
            accessibilityElementsHidden: searching,
            style: [styles.bottomBar, { bottom: insets.bottom + materialBottomBar.inset, left: side, right: side }, !hasTabs ? styles.emptyBar : null, fade],
          }}
        />
      )}
    </View>
  );
}

function StartIconButton({ icon, label, scheme, dot = false, onPress }: { icon: SymbolName; label: string; scheme: MaterialScheme; dot?: boolean; onPress: () => void }) {
  const button = <MaterialIconButton testID={`materialStart:${label}`} icon={icon} label={withUpdateWords(label, dot)} scheme={scheme} onPress={onPress} />;
  if (!dot) return button;
  return (
    <View>
      {button}
      <NoticeDot style={dotBesideGlyph(materialSize.touchTarget)} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  topBar: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", alignItems: "center", minHeight: materialSize.topAppBar, gap: 4 },
  center: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  logo: { alignItems: "center", gap: 16 },
  bottomBar: { position: "absolute" },
  emptyBar: { backgroundColor: "transparent", elevation: 0 },
});
