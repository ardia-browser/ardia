import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Animated, findNodeHandle, Pressable, StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native";
import { DialogFocusContext, nextDialogButton, type DialogButton } from "./dialogFocus";
import { curve, duration } from "./motion";
import { Panel } from "./Panel";
import { Text } from "./Text";
import { useTheme } from "./theme";
import { perLook, proseLineHeight, radius, shadow, sheetWidth, space, type SheetSize, type Space } from "./tokens";

const CENTERED: StyleProp<ViewStyle> = [StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }];

export function Dialog({
  width,
  pad = "xxl",
  onDismiss,
  onSubmit,
  restoreFocus,
  animated = false,
  maxHeight,
  place,
  backdropCloses = true,
  children,
}: {
  width: SheetSize;
  pad?: Space;
  onDismiss?: () => void;
  onSubmit?: () => void;
  restoreFocus?: () => void;
  animated?: boolean;
  maxHeight?: DimensionValue;
  place?: Pick<ViewStyle, "top" | "left" | "right" | "bottom">;
  backdropCloses?: boolean;
  children: ReactNode;
}) {
  const theme = useTheme();
  const surfaceWidth = sheetWidth[width];
  const appear = useRef(new Animated.Value(animated ? 0 : 1)).current;
  const restore = useRef(restoreFocus);
  restore.current = restoreFocus;
  useEffect(() => {
    if (animated) Animated.timing(appear, { toValue: 1, duration: duration.base, easing: curve.enter, useNativeDriver: true }).start();
    return () => restore.current?.();
  }, []);
  const content = onSubmit ? (
    <DialogKeys onDismiss={onDismiss} onSubmit={onSubmit} pad={pad}>
      {children}
    </DialogKeys>
  ) : (
    <DialogFocusContext.Provider value={null}>{children}</DialogFocusContext.Provider>
  );
  const padding = onSubmit ? undefined : space[pad];
  const surface = (
    <Panel
      radius={radius.sheet}
      shadow={shadow.dialog}
      style={place ? { position: "absolute", ...place, width: surfaceWidth, padding } : { width: surfaceWidth, maxHeight, padding }}
    >
      {content}
    </Panel>
  );
  if (place)
    return (
      <View style={StyleSheet.absoluteFill}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />
        {surface}
      </View>
    );
  if (!animated)
    return (
      <View style={CENTERED}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: theme.scrim }]} onPress={backdropCloses ? onDismiss : undefined} />
        {surface}
      </View>
    );
  return (
    <View style={CENTERED}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: appear, backgroundColor: theme.scrim }]}>
        <Pressable focusable={false} style={StyleSheet.absoluteFill} onPress={onDismiss} />
      </Animated.View>
      <Animated.View style={{ opacity: appear, transform: [{ scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }] }}>{surface}</Animated.View>
    </View>
  );
}

const DIALOG_KEYS = [{ key: "Escape" }, { key: "Enter" }, { key: "Tab" }, { key: "Tab", shiftKey: true }];
const targetTag = (event: object) => (event as { target?: number }).target;

function DialogKeys({ onDismiss, onSubmit, pad, children }: { onDismiss?: () => void; onSubmit: () => void; pad: Space; children: ReactNode }) {
  const keys = useRef<View>(null);
  const buttons = useRef<DialogButton[]>([]);
  const register = useCallback((button: DialogButton) => {
    buttons.current = [...buttons.current, button];
    return () => {
      buttons.current = buttons.current.filter((b) => b !== button);
    };
  }, []);
  useEffect(() => keys.current?.focus(), []);
  const focusNextButton = (target: number | undefined, back: boolean) => {
    const views = buttons.current.map((button) => button());
    const next = nextDialogButton(views.map((view) => view && findNodeHandle(view)), target, findNodeHandle(keys.current), back);
    if (next === null) return false;
    views[next]?.focus();
    return true;
  };
  return (
    <View
      ref={keys}
      focusable
      enableFocusRing={false}
      keyDownEvents={DIALOG_KEYS}
      onKeyDown={(e) => {
        if (e.nativeEvent.key === "Escape") onDismiss?.();
        else if (e.nativeEvent.key === "Tab") {
          if (focusNextButton(targetTag(e.nativeEvent), !!e.nativeEvent.shiftKey)) e.preventDefault();
        }
        else if (e.nativeEvent.key === "Enter" && targetTag(e.nativeEvent) === findNodeHandle(keys.current)) onSubmit();
      }}
      style={{ padding: space[pad] }}
    >
      <DialogFocusContext.Provider value={register}>{children}</DialogFocusContext.Provider>
    </View>
  );
}

export function Sheet({ size = "m", onClose, backdropCloses, children }: { size?: SheetSize; onClose: () => void; backdropCloses?: boolean; children: ReactNode }) {
  return (
    <Dialog width={size} maxHeight="90%" onDismiss={onClose} backdropCloses={backdropCloses}>
      {children}
    </Dialog>
  );
}

const TITLE_ROW = { flexDirection: "row", alignItems: "center", gap: space.l } as const;
const TITLE_TEXT = { flex: 1 } as const;
const subtitleStyle = perLook(() => ({ lineHeight: proseLineHeight.small, marginTop: space.s }));

export function DialogTitle({ icon, subtitle, children }: { icon?: ReactNode; subtitle?: ReactNode; children: ReactNode }) {
  const title = (
    <Text size="title" weight="semibold">
      {children}
    </Text>
  );
  const sub =
    subtitle == null || subtitle === false ? null : typeof subtitle === "string" ? (
      <Text size="small" tone="textSecondary" style={subtitleStyle()}>
        {subtitle}
      </Text>
    ) : (
      subtitle
    );
  if (!icon)
    return (
      <View>
        {title}
        {sub}
      </View>
    );
  return (
    <View style={TITLE_ROW}>
      {icon}
      <View style={TITLE_TEXT}>
        {title}
        {sub}
      </View>
    </View>
  );
}

const ACTIONS = { flexDirection: "row", alignItems: "center", gap: space.m, marginTop: space.xl } as const;
const ACTIONS_GAP = { flex: 1 } as const;

export function DialogActions({ leading, note, children }: { leading?: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <View style={ACTIONS}>
      {leading}
      {note == null || note === false ? (
        <View style={ACTIONS_GAP} />
      ) : (
        <View style={ACTIONS_GAP}>
          {typeof note === "string" ? (
            <Text size="caption" tone="textSecondary">
              {note}
            </Text>
          ) : (
            note
          )}
        </View>
      )}
      {children}
    </View>
  );
}
