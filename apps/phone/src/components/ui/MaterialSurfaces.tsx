import { useEffect, useRef, useState, type ReactNode } from "react";
import { BackHandler, KeyboardAvoidingView, StyleSheet, Text, useWindowDimensions, View, type ViewInstance, type ViewStyle } from "react-native";
import { Gesture, GestureDetector, Pressable } from "react-native-gesture-handler";
import Animated, { cancelAnimation, interpolateColor, runOnJS, useAnimatedStyle, useDerivedValue, useSharedValue, withDelay, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { predictiveBack, TRAY_BACK_TRAVEL } from "@ardia/phone-native";
import { withAlpha } from "../../lib/color";
import { clampedProgress, trayDragDismisses, trayDragOffset, trayExpansionTarget } from "../../lib/trayMotion";
import { useReduceMotion } from "./contrast";
import { useCoverFocus } from "./coverFocus";
import { MATERIAL_STATE } from "./materialRoles";
import { useMaterialTheme } from "./materialTheme";
import { materialBottomBar, materialDuration, materialMotion, materialMove, materialShape, materialSize, materialType } from "./materialTokens";
import { reducedMotionMs } from "./motion";
import { Portal } from "./Overlay";
import { Symbol } from "./Symbol";
import type { SymbolName } from "./symbolPaths";
import { t } from "../../lib/uiLanguage";


const HIDE_FALLBACK_MS = 900;
const SHEET_TOP_GAP = materialSize.topAppBar;

type MaterialBackHandlers = { onProgress?: (progress: number) => void; onCancel?: () => void; onCommit: () => void; onSwipe?: () => void };

let materialBackSwiped = () => undefined as void;

export const onMaterialBackSwiped = (count: () => void) => {
  materialBackSwiped = count;
};

export const countMaterialBackSwipe = () => materialBackSwiped();

export function backSwipe(count: () => void) {
  let moved = false;
  return {
    progress: (progress: number) => {
      if (progress > 0) moved = true;
    },
    cancel: () => {
      moved = false;
    },
    commit: () => {
      if (moved) count();
      moved = false;
    },
  };
}

export function useMaterialBack(active: boolean, handlers: MaterialBackHandlers, fallback = true) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (!active) return;
    if (predictiveBack.isNative()) {
      const swipe = backSwipe(() => (latest.current.onSwipe ?? countMaterialBackSwipe)());
      const claim = predictiveBack.claim({
        onProgress: (progress) => {
          swipe.progress(progress);
          latest.current.onProgress?.(progress);
        },
        onCancel: () => {
          swipe.cancel();
          latest.current.onCancel?.();
        },
        onCommit: () => {
          swipe.commit();
          latest.current.onCommit();
        },
      });
      return () => claim.remove();
    }
    if (!fallback) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      latest.current.onCommit();
      return true;
    });
    return () => back.remove();
  }, [active, fallback]);
}

export const materialSheetBackOffset = (progress: number) => {
  "worklet";
  return Math.min(Math.max(progress, 0), 1) * TRAY_BACK_TRAVEL;
};

export function useMaterialRipple(borderless = false) {
  const { scheme } = useMaterialTheme();
  return { color: withAlpha(scheme.onSurface, MATERIAL_STATE.pressed), borderless, foreground: !borderless };
}

export function DragHandle({ onPress }: { onPress?: () => void }) {
  const { scheme } = useMaterialTheme();
  return (
    <Pressable testID="materialDragHandle" accessibilityRole="button" accessibilityLabel={t(`Dismiss`)} onPress={onPress} disabled={!onPress} style={styles.handleHit}>
      <View style={[styles.handle, { backgroundColor: withAlpha(scheme.onSurfaceVariant, 0.4) }]} />
    </Pressable>
  );
}

export const MATERIAL_SWITCH = { width: 52, height: 32, border: 2, handleOff: 16, handleOn: 24 } as const;

export const materialSwitchHandle = (on: number) => {
  "worklet";
  const inner = MATERIAL_SWITCH.height - MATERIAL_SWITCH.border * 2;
  const size = MATERIAL_SWITCH.handleOff + (MATERIAL_SWITCH.handleOn - MATERIAL_SWITCH.handleOff) * on;
  const offLeft = (inner - MATERIAL_SWITCH.handleOff) / 2;
  const onLeft = MATERIAL_SWITCH.width - MATERIAL_SWITCH.border * 2 - MATERIAL_SWITCH.handleOn - (inner - MATERIAL_SWITCH.handleOn) / 2;
  return { size, left: offLeft + (onLeft - offLeft) * on, top: (inner - size) / 2 };
};

export function MaterialSwitchTrack({ value, disabled }: { value: boolean; disabled?: boolean }) {
  const { scheme } = useMaterialTheme();
  const reduceMotion = useReduceMotion();
  const on = useSharedValue(value ? 1 : 0);
  useEffect(() => {
    on.value = materialMove(value ? 1 : 0, "standard", reduceMotion ? reducedMotionMs(materialDuration.short4) : materialDuration.short4);
  }, [value]);
  const trackOff = scheme.surfaceContainerHighest;
  const trackOn = scheme.primary;
  const borderOff = scheme.outline;
  const handleOff = scheme.outline;
  const handleOn = scheme.onPrimary;
  const track = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(on.value, [0, 1], [trackOff, trackOn]), borderColor: interpolateColor(on.value, [0, 1], [borderOff, trackOn]) }), [trackOff, trackOn, borderOff]);
  const handle = useAnimatedStyle(() => {
    const place = materialSwitchHandle(on.value);
    return { width: place.size, height: place.size, borderRadius: place.size / 2, left: place.left, top: place.top, backgroundColor: interpolateColor(on.value, [0, 1], [handleOff, handleOn]) };
  }, [handleOff, handleOn]);
  return (
    <Animated.View testID="materialSwitch" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.switchTrack, track, disabled ? styles.switchDisabled : null]}>
      <Animated.View style={[styles.switchHandle, handle]} />
    </Animated.View>
  );
}

export const materialSheetMs = (reduceMotion: boolean, entering: boolean) =>
  reduceMotion ? reducedMotionMs(materialDuration.short3) : entering ? materialMotion.sheetEnter.durationMs : materialMotion.sheetExit.durationMs;

type ExpandableList = { scrollY: SharedValue<number>; compactMaxHeight: number; onExpand?: () => void };
export type MaterialSheetSearch = {
  height: SharedValue<number>;
  keyboard: SharedValue<number>;
  barSide?: number;
  claimsBack: boolean;
  incognito: boolean;
  onBackSwipe: () => void;
};
type SheetProps = { open: boolean; onDismiss: () => void; onTapAway?: () => void; onBack?: () => void; onHidden: () => void; expandableList?: ExpandableList; dockedBar?: (spread: SharedValue<number>) => ReactNode; dockedBarReserved?: boolean; dockedBarColor?: string; search?: MaterialSheetSearch; children: ReactNode };

export function MaterialSheet({ open, onDismiss, onTapAway, onBack, onHidden, expandableList, dockedBar, dockedBarReserved = true, dockedBarColor, search, children }: SheetProps) {
  const { scheme } = useMaterialTheme(search?.incognito);
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const across = Math.max(width - insets.left - insets.right, 0);
  const sheetWidth = Math.min(across, materialSize.sheetMaxWidth);
  const maxHeight = Math.max(0, Math.min(height - insets.top - SHEET_TOP_GAP, expandableList?.compactMaxHeight ?? height));
  const expandable = expandableList !== undefined;
  const listScrollY = expandableList?.scrollY;
  const onExpand = expandableList?.onExpand;
  const docksBar = dockedBar !== undefined;
  const reduceMotion = useReduceMotion();
  const shown = useSharedValue(0);
  const barSpread = useSharedValue(0);
  const drag = useSharedValue(0);
  const sheetHeight = useSharedValue(docksBar ? maxHeight : height);
  const compactHeight = useSharedValue(maxHeight);
  const expansion = useSharedValue(0);
  const searching = search !== undefined;
  const searchHeight = search?.height;
  const searchKeyboard = search?.keyboard;
  const searchProgress = useSharedValue(searching ? 1 : 0);
  const searchStartHeight = useSharedValue(maxHeight);
  useEffect(() => {
    if (!searching) {
      searchProgress.value = 0;
      return;
    }
    if (searchProgress.value === 1) return;
    searchStartHeight.value = expansion.value > 0 ? compactHeight.value : sheetHeight.value;
    searchProgress.value = materialMove(1, "emphasized", reduceMotion ? 0 : materialDuration.short4);
  }, [searching, reduceMotion]);
  const compact = useDerivedValue(() => {
    if (searchHeight) return searchStartHeight.value + (searchHeight.value - searchStartHeight.value) * searchProgress.value;
    return expansion.value > 0 ? compactHeight.value : sheetHeight.value;
  });
  const liveSheetHeight = useDerivedValue(() => compact.value + (height - compact.value) * expansion.value);
  const resizeStart = useSharedValue(0);
  const resizing = useSharedValue(false);
  const touchStart = useSharedValue({ x: 0, y: 0, inHeader: false });
  const headerHeight = materialSize.touchTarget + (docksBar ? materialBottomBar.field + materialBottomBar.inset : 0);
  const panel = useRef<ViewInstance>(null);
  useCoverFocus(panel);
  useMaterialBack(
    open && (search?.claimsBack ?? true),
    {
      onProgress: (progress) => {
        if (!onBack) drag.value = materialSheetBackOffset(progress);
      },
      onCancel: () => {
        if (!onBack) drag.value = materialMove(0, "standard", materialDuration.short4);
      },
      onCommit: () => (onBack ? onBack() : onDismiss()),
      onSwipe: search?.onBackSwipe,
    },
    searching,
  );
  useEffect(() => {
    const spreadMs = docksBar && !reduceMotion ? materialDuration.short3 : 0;
    const slideMs = materialSheetMs(reduceMotion, open);
    if (open) {
      drag.value = 0;
      barSpread.value = materialMove(1, "standard", spreadMs);
      const rise = materialMove(1, materialMotion.sheetEnter.easing, slideMs);
      shown.value = spreadMs > 0 ? withDelay(spreadMs, rise) : rise;
      return;
    }
    const hidden = (finished?: boolean) => {
      "worklet";
      if (finished) runOnJS(onHidden)();
    };
    if (docksBar) drag.value = materialMove(0, materialMotion.sheetExit.easing, slideMs);
    if (spreadMs > 0) {
      shown.value = materialMove(0, materialMotion.sheetExit.easing, slideMs);
      barSpread.value = withDelay(slideMs, materialMove(0, "standard", spreadMs, hidden));
    } else {
      shown.value = materialMove(0, materialMotion.sheetExit.easing, slideMs, hidden);
    }
    const fallback = setTimeout(onHidden, HIDE_FALLBACK_MS);
    return () => clearTimeout(fallback);
  }, [open]);
  const pull = Gesture.Pan()
    .withTestId("sheetDrag")
    .enabled(open && (search?.claimsBack ?? true))
    .manualActivation(expandable)
    .activeOffsetY([-12, 12])
    .failOffsetX([-24, 24])
    .onBegin(() => {
      if (expandable) resizing.value = false;
    })
    .onTouchesDown((event) => {
      if (!expandable) return;
      const first = event.allTouches[0];
      if (first) touchStart.value = { x: first.absoluteX, y: first.absoluteY, inHeader: first.y < headerHeight + insets.top * expansion.value };
    })
    .onTouchesMove((event, manager) => {
      if (!expandable || resizing.value) return;
      const first = event.allTouches[0];
      if (!first) return;
      const dx = first.absoluteX - touchStart.value.x;
      const dy = first.absoluteY - touchStart.value.y;
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) manager.fail();
      else if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
        const fromTop = (listScrollY?.value ?? 0) <= 0;
        const changesSheet = touchStart.value.inHeader || (dy < 0 ? expansion.value < 0.99 : fromTop);
        if (changesSheet) manager.activate();
        else manager.fail();
      }
    })
    .onStart(() => {
      if (!expandable) return;
      resizeStart.value = expansion.value;
      resizing.value = true;
      cancelAnimation(expansion);
      cancelAnimation(drag);
      if (resizeStart.value === 0) compactHeight.value = sheetHeight.value;
    })
    .onUpdate((event) => {
      if (expandable) {
        if (!resizing.value) return;
        const travel = Math.max(height - compact.value, 1);
        expansion.value = clampedProgress(resizeStart.value * travel - event.translationY, travel);
      }
      drag.value = !expandable || (resizeStart.value === 0 && event.translationY > 0) ? trayDragOffset(event.translationY) : 0;
    })
    .onEnd((event, success) => {
      if (!success) return;
      if (expandable && !resizing.value) return;
      if ((!expandable || resizeStart.value === 0) && trayDragDismisses(event.translationY, event.velocityY, sheetHeight.value)) {
        runOnJS(onDismiss)();
        return;
      }
      if (expandable) {
        const target = trayExpansionTarget(expansion.value, event.translationY, event.velocityY);
        if (target === 1 && resizeStart.value < 0.5 && onExpand) runOnJS(onExpand)();
        expansion.value = materialMove(target, "emphasized", reduceMotion ? 0 : materialDuration.medium1);
      }
      drag.value = materialMove(0, "standard", materialDuration.short4);
    })
    .onFinalize((_event, success) => {
      if (success) return;
      if (!expandable) {
        drag.value = materialMove(0, "standard", reduceMotion ? 0 : materialDuration.short4);
        return;
      }
      if (!resizing.value) return;
      expansion.value = materialMove(resizeStart.value, "standard", reduceMotion ? 0 : materialDuration.short4);
      drag.value = materialMove(0, "standard", reduceMotion ? 0 : materialDuration.short4);
    });
  const scrim = useAnimatedStyle(() => ({ opacity: Math.min(Math.max(shown.value, 0), 1) * (1 - clampedProgress(drag.value, sheetHeight.value)) }));
  const searchBody = useAnimatedStyle(() => ({
    opacity: clampedProgress(Math.min(shown.value, searchProgress.value) - 0.65, 0.35),
  }));
  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: reduceMotion ? drag.value : (1 - shown.value) * liveSheetHeight.value + drag.value }], opacity: reduceMotion ? shown.value : 1 }));
  const resize = useAnimatedStyle(() => {
    if (!expandable) return {};
    const progress = expansion.value;
    const radius = materialShape.extraLarge * (1 - progress);
    return {
      height: searching || progress > 0 ? liveSheetHeight.value : undefined,
      maxHeight: searching || progress > 0 ? height : maxHeight,
      left: (insets.left + (across - sheetWidth) / 2) * (1 - progress),
      width: sheetWidth + (width - sheetWidth) * progress,
      paddingTop: insets.top * progress,
      paddingLeft: insets.left * progress,
      paddingRight: insets.right * progress,
      paddingBottom: searching ? Math.max(insets.bottom, searchKeyboard?.value ?? 0) + materialBottomBar.inset : insets.bottom,
      borderTopLeftRadius: radius,
      borderTopRightRadius: radius,
    };
  });
  const dockedBarStyle = useAnimatedStyle(() => {
    const expanded = expansion.value;
    const panelLeft = (insets.left + (across - sheetWidth) / 2) * (1 - expanded);
    const panelWidth = sheetWidth + (width - sheetWidth) * expanded;
    const barSide = search?.barSide ?? Math.max(insets.left, insets.right) + materialBottomBar.edge + materialBottomBar.pad + materialSize.touchTarget + materialBottomBar.gap;
    const bottom = insets.bottom + materialBottomBar.inset + (materialBottomBar.height - materialBottomBar.field) / 2;
    const dockInset = materialSize.touchTarget + insets.top * expanded;
    const lift = liveSheetHeight.value - bottom - materialBottomBar.field - dockInset;
    return {
      bottom,
      transform: [{ translateY: drag.value - lift * shown.value }],
      left: barSide * (1 - barSpread.value) + (panelLeft + materialBottomBar.edge + insets.left * expanded) * barSpread.value,
      right: barSide * (1 - barSpread.value) + (width - panelLeft - panelWidth + materialBottomBar.edge + insets.right * expanded) * barSpread.value,
    };
  });
  const grip = (
    <View testID="materialSheetGrip" collapsable={false}>
      <DragHandle onPress={onDismiss} />
    </View>
  );
  const sheet = (
    <Animated.View
      ref={panel}
      testID="materialSheet"
      accessibilityViewIsModal
      collapsable={false}
      onLayout={(event) => {
        sheetHeight.value = event.nativeEvent.layout.height;
      }}
      style={[styles.sheet, { left: insets.left + (across - sheetWidth) / 2, width: sheetWidth, maxHeight: searching ? height : maxHeight, paddingBottom: insets.bottom, backgroundColor: search?.incognito ? scheme.surface : scheme.surfaceContainerLow }, slide, resize]}
    >
      {expandable ? grip : <GestureDetector gesture={pull}>{grip}</GestureDetector>}
      {dockedBar && dockedBarReserved ? <View style={styles.dockedBarSpace} /> : null}
      {searching ? <Animated.View style={[styles.searchBody, searchBody]}>{children}</Animated.View> : children}
    </Animated.View>
  );
  const dockedBarFill = dockedBarReserved ? (dockedBarColor ?? (searching ? scheme.surfaceContainerHigh : undefined)) : undefined;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={open ? "box-none" : "none"} collapsable={false} importantForAccessibility={open ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={!open}>
      <Animated.View testID="materialScrim" style={[StyleSheet.absoluteFill, scrim]}>
        <Pressable accessibilityLabel={searching ? t(`Close Search`) : t(`Close`)} style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(scheme.scrim, MATERIAL_STATE.scrim) }]} onPress={() => {
            onTapAway?.();
            onDismiss();
          }} />
      </Animated.View>
      {dockedBar ? (
        <Animated.View
          testID="materialSheetDockedBar"
          pointerEvents={dockedBarReserved ? "box-none" : "none"}
          collapsable={false}
          importantForAccessibility={dockedBarReserved ? "auto" : "no-hide-descendants"}
          accessibilityElementsHidden={!dockedBarReserved}
          style={[styles.dockedBar, { display: dockedBarReserved ? "flex" : "none", backgroundColor: dockedBarFill ?? "transparent", elevation: dockedBarFill ? 2 : 0 }, dockedBarStyle]}
        >
          {dockedBar(barSpread)}
        </Animated.View>
      ) : null}
      {expandable ? <GestureDetector gesture={pull}>{sheet}</GestureDetector> : sheet}
    </View>
  );
}

export type MaterialDialogButton = { title: string; onPress: () => void; destructive?: boolean };

export function MaterialDialog({ title, message, buttons, onDismiss, children }: { title: string; message?: string | null; buttons: MaterialDialogButton[]; onDismiss: () => void; children?: ReactNode }) {
  const { scheme } = useMaterialTheme();
  const ripple = useMaterialRipple();
  const shown = useSharedValue(0);
  const reduceMotion = useReduceMotion();
  useMaterialBack(true, { onCommit: onDismiss });
  useEffect(() => {
    shown.value = materialMove(1, materialMotion.dialogEnter.easing, reduceMotion ? reducedMotionMs(materialDuration.short3) : materialMotion.dialogEnter.durationMs);
  }, []);
  const scrim = useAnimatedStyle(() => ({ opacity: shown.value }));
  const panel = useAnimatedStyle(() => ({ opacity: shown.value, transform: [{ scale: 0.9 + 0.1 * shown.value }] }));
  return (
    <Portal>
      <Animated.View testID="materialDialogScrim" style={[StyleSheet.absoluteFill, scrim]}>
        <Pressable accessibilityLabel={t(`Dismiss`)} style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(scheme.scrim, MATERIAL_STATE.scrim) }]} onPress={onDismiss} />
      </Animated.View>
      <KeyboardAvoidingView style={styles.center} pointerEvents="box-none">
        <Animated.View testID="materialDialog" accessibilityViewIsModal style={[styles.dialog, { backgroundColor: scheme.surfaceContainerHigh }, panel]}>
          <Text accessibilityRole="header" style={[materialType.headlineSmall, { color: scheme.onSurface }]}>
            {title}
          </Text>
          {message ? <Text style={[materialType.bodyMedium, { color: scheme.onSurfaceVariant }]}>{message}</Text> : null}
          {children}
          <View style={styles.dialogButtons}>
            {buttons.map((button) => (
              <Pressable key={button.title} accessibilityRole="button" android_ripple={ripple} onPress={button.onPress} style={styles.textButton}>
                <Text style={[materialType.labelLarge, { color: button.destructive ? scheme.error : scheme.primary }]}>{button.title}</Text>
              </Pressable>
            ))}
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Portal>
  );
}

export type MaterialMenuEntry =
  | { label: string; icon?: SymbolName; destructive?: boolean; checked?: boolean; disabled?: boolean; onPress: () => void; submenu?: false }
  | { label: string; icon?: SymbolName; disabled?: boolean; onPress: () => void; submenu: true }
  | "divider"
  | { heading: string };

const MENU_WIDTH_STEP = 56;
const MATERIAL_MENU_GROUP_GAP = 4;
const MENU_MIN_WIDTH = 112;
const MENU_MAX_WIDTH = 280;
const LABEL_CHAR_WIDTH = 8;

export function materialMenuWidth(entries: readonly MaterialMenuEntry[]): number {
  const widest = entries.reduce((most, entry) => {
    if (entry === "divider" || "heading" in entry) return most;
    const icons = (entry.icon ? materialSize.icon + 12 : 0) + (entry.submenu || ("checked" in entry && entry.checked) ? materialSize.icon + 12 : 0);
    return Math.max(most, 24 + icons + entry.label.length * LABEL_CHAR_WIDTH);
  }, 0);
  return Math.min(MENU_MAX_WIDTH, Math.max(MENU_MIN_WIDTH, Math.ceil(widest / MENU_WIDTH_STEP) * MENU_WIDTH_STEP));
}

export const materialMenuFill = (scheme: { surfaceContainer: string; surfaceContainerHighest: string }, dark: boolean) => (dark ? scheme.surfaceContainerHighest : scheme.surfaceContainer);

export function materialMenuGroups(entries: readonly MaterialMenuEntry[]): { entry: MaterialMenuEntry; index: number }[][] {
  const groups: { entry: MaterialMenuEntry; index: number }[][] = [[]];
  entries.forEach((entry, index) => {
    if (entry === "divider") {
      if (groups[groups.length - 1]!.length) groups.push([]);
      return;
    }
    groups[groups.length - 1]!.push({ entry, index });
  });
  return groups.filter((group) => group.length > 0);
}

export function MaterialMenuPanel({ entries, place, panel }: { entries: MaterialMenuEntry[]; place: ViewStyle; panel?: React.RefObject<ViewInstance | null> }) {
  const { scheme, dark } = useMaterialTheme();
  const ripple = useMaterialRipple();
  const shown = useSharedValue(0);
  useEffect(() => {
    shown.value = materialMove(1, materialMotion.menuEnter.easing, materialMotion.menuEnter.durationMs);
  }, []);
  const enter = useAnimatedStyle(() => ({ opacity: Math.min(1, shown.value * 3), transform: [{ scaleY: 0.8 + 0.2 * shown.value }] }));
  return (
    <Animated.View ref={panel} testID="materialMenu" accessibilityViewIsModal style={[styles.menu, { width: materialMenuWidth(entries) }, place, enter]}>
      {materialMenuGroups(entries).map((group, groupIndex) => (
        <View key={groupIndex} testID="materialMenuGroup" style={[styles.menuGroup, { backgroundColor: materialMenuFill(scheme, dark) }]}>
          {group.map(({ entry, index }) => {
            if (entry === "divider") return null;
            if ("heading" in entry)
              return (
                <Text key={`h${index}`} style={[materialType.titleSmall, styles.menuHeading, { color: scheme.onSurfaceVariant }]}>
                  {entry.heading}
                </Text>
              );
            const destructive = !entry.submenu && entry.destructive;
            const color = entry.disabled ? withAlpha(scheme.onSurface, MATERIAL_STATE.disabledContent) : destructive ? scheme.error : scheme.onSurface;
            const iconColor = entry.disabled ? color : destructive ? scheme.error : scheme.onSurfaceVariant;
            return (
              <Pressable
                key={`${index}:${entry.label}`}
                accessibilityRole="menuitem"
                accessibilityLabel={entry.label}
                accessibilityState={entry.submenu ? { disabled: entry.disabled, expanded: false } : { checked: entry.checked, disabled: entry.disabled }}
                disabled={entry.disabled}
                android_ripple={ripple}
                onPress={entry.onPress}
                style={styles.menuItem}
              >
                {entry.icon ? <Symbol name={entry.icon} size={materialSize.icon} color={iconColor} /> : null}
                <Text style={[materialType.labelLarge, styles.menuLabel, { color }]} numberOfLines={1}>
                  {entry.label}
                </Text>
                {entry.submenu ? <Symbol name="chevronRight" size={materialSize.icon} color={iconColor} /> : entry.checked ? <Symbol name="checkmark" size={materialSize.icon} color={scheme.primary} /> : null}
              </Pressable>
            );
          })}
        </View>
      ))}
    </Animated.View>
  );
}

export function useMaterialMenuPage<T>() {
  return useState<T | null>(null);
}

const styles = StyleSheet.create({
  switchTrack: { width: MATERIAL_SWITCH.width, height: MATERIAL_SWITCH.height, borderRadius: MATERIAL_SWITCH.height / 2, borderWidth: MATERIAL_SWITCH.border },
  switchHandle: { position: "absolute" },
  switchDisabled: { opacity: MATERIAL_STATE.disabledContent },
  handleHit: { alignSelf: "center", width: materialSize.touchTarget, height: materialSize.touchTarget, alignItems: "center", justifyContent: "center" },
  handle: { width: materialSize.dragHandle.width, height: materialSize.dragHandle.height, borderRadius: materialShape.full },
  sheet: {
    position: "absolute",
    bottom: 0,
    overflow: "hidden",
    borderTopLeftRadius: materialShape.extraLarge,
    borderTopRightRadius: materialShape.extraLarge,
    elevation: 1,
    zIndex: 1,
  },
  dockedBarSpace: { height: materialBottomBar.field + materialBottomBar.inset },
  dockedBar: { position: "absolute", height: materialBottomBar.field, borderRadius: materialShape.full, zIndex: 2 },
  searchBody: { flex: 1 },
  center: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", padding: 24 },
  dialog: { minWidth: 280, maxWidth: 560, width: "100%", borderRadius: materialShape.extraLarge, padding: 24, gap: 16, elevation: 3 },
  dialogButtons: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 8 },
  textButton: { minHeight: materialSize.touchTarget, minWidth: materialSize.touchTarget, paddingHorizontal: 12, justifyContent: "center", alignItems: "center", borderRadius: materialShape.full, overflow: "hidden" },
  menu: { position: "absolute", minWidth: 112, maxWidth: 280, gap: MATERIAL_MENU_GROUP_GAP, transformOrigin: "top" },
  menuGroup: { borderRadius: materialShape.large, paddingVertical: 4, elevation: 3, overflow: "hidden" },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: materialSize.touchTarget, paddingHorizontal: 12 },
  menuLabel: { flex: 1 },
  menuHeading: { paddingHorizontal: 12, paddingVertical: 8 },
});
