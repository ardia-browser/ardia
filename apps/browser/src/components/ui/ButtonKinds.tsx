import { useEffect, useRef, type ReactNode } from "react";
import { Surface, VisualEffect } from "@ardia/shell";
import { Symbol } from "./Symbol";
import { Animated, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import { Crossfade } from "./Expand";
import { useHover } from "./useHover";
import { HoverFill, HoverSwap } from "./HoverFill";
import { hex, useTheme, type Theme } from "./theme";
import { capsule, closeOnArt, opacity, pillHeight, radius as radii, space, stepperSize, font as typeScale, weight as weights, withAlpha } from "./tokens";
import { buttonMotion, crossfade, curve, period, usePressScaleMotion } from "./motion";
import type { CloseProps, PillProps, PushProps, StepperProps } from "./Button";

function ScaledGlyph({ scale, size, children }: { scale: Animated.Value | null; size: number; children: ReactNode }) {
  const style = { width: size, height: size, alignItems: "center" as const, justifyContent: "center" as const };
  return scale ? <Animated.View pointerEvents="none" style={[style, { transform: [{ scale }] }]}>{children}</Animated.View> : <View pointerEvents="none" style={style}>{children}</View>;
}

function pillLook(theme: Theme, tone: "prompt" | "chip", primary: boolean, pressed: boolean, hovered: boolean) {
  if (tone === "chip")
    return primary
      ? { fill: theme.textPrimary, text: theme.onPrimary, dim: pressed || hovered }
      : { fill: pressed ? theme.toolbarPressed : hovered ? theme.toolbarHover : theme.urlPill, text: theme.textPrimary, dim: false };
  return primary
    ? { fill: pressed ? theme.goButtonPressed : hovered ? theme.goButtonHover : theme.goButton, text: theme.onPrimary, dim: false }
    : { fill: pressed ? theme.promptFillPressed : hovered ? theme.promptFillHover : theme.promptFill, text: theme.textPrimary, dim: false };
}

export function StepperButtonView({ icon, onPress, width = stepperSize.width, height = stepperSize.height, tooltip, disabled }: StepperProps) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const pressMotion = usePressScaleMotion();
  return (
    <View {...hoverProps} style={{ opacity: disabled ? opacity.disabled : 1 }}>
      <Pressable disabled={disabled} onPress={onPress} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut} tooltip={tooltip}>
        {({ pressed }) => (
          <View
            style={{
              width,
              height,
              borderRadius: radii.control,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: StyleSheet.hairlineWidth * 2,
              borderColor: theme.controlBorder,
            }}
          >
            <HoverSwap shown={!disabled && (pressed || hovered)} rest={theme.control} color={pressed ? theme.controlPressed : theme.controlHover} radius={radii.control} underBorder={StyleSheet.hairlineWidth * 2} />
            <ScaledGlyph scale={pressMotion.scale} size={12}><Symbol name={icon} size={10} weight="semibold" color={theme.icon} style={{ width: 12, height: 12 }} /></ScaledGlyph>
          </View>
        )}
      </Pressable>
    </View>
  );
}

const CHIP_DIM = 0.85;

export function PillButtonView(props: PillProps) {
  const { onPress, title, primary = false, size, reserve } = props;
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const pressMotion = usePressScaleMotion(true, buttonMotion.controlPressScale);
  const scaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : null;
  if (props.tone === "chip") {
    const { icon, tone } = props;
    const chipHeight = props.height ?? pillHeight[size ?? "m"];
    return (
      <View {...hoverProps}>
        <Pressable onPress={onPress} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut}>
          {({ pressed }) => {
            const look = pillLook(theme, tone, primary, pressed, hovered);
            const rest = pillLook(theme, tone, primary, false, false);
            const ink = look.text;
            return (
              <Animated.View
                style={[{
                  height: chipHeight,
                  borderRadius: capsule(chipHeight),
                  paddingHorizontal: space.m,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: space.xs,
                  opacity: look.dim ? CHIP_DIM : 1,
                }, scaleStyle]}
              >
                <HoverSwap shown={pressed || hovered} rest={rest.fill} color={look.fill} radius={capsule(chipHeight)} />
                {icon ? <Symbol name={icon} size={10.5} weight="semibold" color={ink} style={{ width: 14, height: 14 }} /> : null}
                <TitleSwap title={title} reserve={reserve} style={{ ...typeScale.small, fontWeight: weights.medium, color: ink }} />
              </Animated.View>
            );
          }}
        </Pressable>
      </View>
    );
  }
  const height = size ? pillHeight[size] : pillHeight.prompt;
  const disabled = !!props.disabled;
  return (
    <View {...hoverProps} style={{ opacity: disabled ? opacity.disabled : 1 }}>
      <Pressable
        disabled={disabled}
        onPress={onPress}
        onPressIn={pressMotion.onPressIn}
        onPressOut={pressMotion.onPressOut}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
      >
        {({ pressed }) => {
          const look = pillLook(theme, "prompt", primary, !disabled && pressed, !disabled && hovered);
          return (
            <Animated.View style={[{ height, paddingHorizontal: space.l, alignItems: "center", justifyContent: "center" }, scaleStyle]}>
              <HoverSwap shown={!disabled && (pressed || hovered)} rest={pillLook(theme, "prompt", primary, false, false).fill} color={look.fill} radius={size ? capsule(height) : radii.tile} />
              <TitleSwap title={title} reserve={reserve} lines={1} style={{ ...typeScale.body, fontWeight: weights.medium, color: look.text }} />
            </Animated.View>
          );
        }}
      </Pressable>
    </View>
  );
}

export function CloseButtonView(props: CloseProps) {
  const { onPress, look, tooltip = "Dismiss", label, style } = props;
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const pressMotion = usePressScaleMotion();
  if (look === "panel")
    return (
      <View {...hoverProps} style={style} tooltip={tooltip}>
        <Pressable onPress={onPress} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut}>
          <View style={{ width: PANEL_CLOSE_BOX, height: PANEL_CLOSE_BOX, alignItems: "center", justifyContent: "center" }}>
              <HoverFill shown={hovered} color={theme.toolbarHover} radius={radii.control} />
              <ScaledGlyph scale={pressMotion.scale} size={14}><Symbol name="xmark" size={9} weight="semibold" color={theme.textSecondary} style={{ width: 14, height: 14 }} /></ScaledGlyph>
          </View>
        </Pressable>
      </View>
    );
  if (props.look === "art") {
    const size = props.box ?? ART_CLOSE_BOX;
    const corner = props.radius ?? capsule(size);
    return (
      <View {...hoverProps} style={style} tooltip={tooltip}>
        <Pressable onPress={onPress} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut} accessibilityRole="button" accessibilityLabel={label ?? tooltip}>
          {({ pressed }) => (
            <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
              <HoverSwap shown={pressed || hovered} rest={closeOnArt.rest} color={pressed ? closeOnArt.pressed : closeOnArt.hover} radius={corner} />
              <ScaledGlyph scale={pressMotion.scale} size={size}><Symbol name="xmark" size={11} weight="medium" color={closeOnArt.glyph} style={{ width: size, height: size }} /></ScaledGlyph>
            </View>
          )}
        </Pressable>
      </View>
    );
  }
  const fill = hovered ? theme.hudCloseHover : theme.hudCloseFill;
  return (
    <View {...hoverProps} style={style} tooltip={tooltip}>
      <Pressable onPress={onPress} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut} accessibilityRole="button" accessibilityLabel={label ?? tooltip}>
        <View style={HUD_PLATE}>
          <VisualEffect material="hudWindow" blendingMode="withinWindow" cornerRadius={capsule(HUD_CLOSE_BOX)} style={StyleSheet.absoluteFill} />
          <Surface style={StyleSheet.absoluteFill} fill={hex(fill)} cornerRadius={capsule(HUD_CLOSE_BOX)} borderColor={theme.hudCloseBorder} borderWidth={1} />
          <ScaledGlyph scale={pressMotion.scale} size={HUD_CLOSE_BOX}><Symbol name="xmark" size={10} weight="medium" color={theme.hudCloseGlyph} style={HUD_GLYPH} /></ScaledGlyph>
        </View>
      </Pressable>
    </View>
  );
}

const PANEL_CLOSE_BOX = 22;
export const PANEL_CLOSE_GLYPH = 7;
export const PANEL_CLOSE_SIZE = PANEL_CLOSE_BOX;
const HUD_CLOSE_BOX = 23;
const ART_CLOSE_BOX = 22;
const HUD_PLATE = { width: HUD_CLOSE_BOX, height: HUD_CLOSE_BOX, borderRadius: capsule(HUD_CLOSE_BOX), overflow: "hidden", alignItems: "center", justifyContent: "center" } as const;
const HUD_GLYPH = { width: HUD_CLOSE_BOX, height: HUD_CLOSE_BOX } as const;

export function TitleSwap({ title, reserve, lines, centersCapitals, style }: { title: string; reserve?: readonly string[]; lines?: number; centersCapitals?: boolean; style: StyleProp<TextStyle> }) {
  const text = (value: string) => (
    <Text key={value} ardiaCentersCapitals={centersCapitals} numberOfLines={lines} style={reserve?.length ? [style, CENTERED] : style}>
      {value}
    </Text>
  );
  if (!reserve?.length) return text(title);
  return (
    <Crossfade id={title} reserve={reserve.map(text)}>
      {text(title)}
    </Crossfade>
  );
}

const CENTERED = { textAlign: "center" } as const;

export function PushButtonView({ title, onPress, kind = "default", disabled, icon, style, reserve, busy: busyProp, label }: PushProps) {
  const busy = busyProp ?? false;
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const pressMotion = usePressScaleMotion(!disabled && !busy, buttonMotion.controlPressScale);
  const scaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : null;
  const primary = kind === "primary";
  const plain = kind === "plain";
  const textColor = primary ? theme.onAccent : kind === "destructive" ? theme.destructive : plain ? theme.formAccent : theme.textPrimary;
  const textStyle = { ...typeScale.body, color: textColor, textDecorationLine: plain && hovered && !disabled && !busy ? "underline" : "none" } as const;
  return (
    <View {...hoverProps} style={[{ opacity: disabled && !busy ? opacity.disabled : 1 }, style]}>
      <Pressable
        disabled={disabled || busy}
        onPress={onPress}
        onAccessibilityTap={disabled || busy ? undefined : onPress}
        accessibilityRole="button"
        accessibilityLabel={label ?? title}
        accessibilityState={{ disabled: !!(disabled || busy), busy }}
        onPressIn={pressMotion.onPressIn}
        onPressOut={pressMotion.onPressOut}
      >
        {({ pressed }) => (
          <Animated.View
            style={[{
              height: plain ? undefined : 22,
              borderRadius: radii.control,
              paddingHorizontal: plain ? 0 : space.ml,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: space.xs,
              backgroundColor: primary ? (pressed && !busy ? theme.formAccentPressed : theme.formAccent) : undefined,
              borderWidth: plain || primary ? 0 : StyleSheet.hairlineWidth * 2,
              borderColor: theme.controlBorder,
            }, scaleStyle]}
          >
            {plain || primary ? null : <HoverSwap shown={!disabled && !busy && (pressed || hovered)} rest={theme.control} color={pressed ? theme.controlPressed : theme.controlHover} radius={radii.control} underBorder={StyleSheet.hairlineWidth * 2} />}
            {icon && !busy ? <Symbol name={icon} size={11} color={textColor} style={{ width: 13, height: 13 }} /> : null}
            {busyProp === undefined ? (
              <TitleSwap title={title} reserve={reserve} centersCapitals={!plain} style={textStyle} />
            ) : (
              <BusySwap busy={busy} color={textColor}>
                <TitleSwap title={title} reserve={reserve} centersCapitals={!plain} style={textStyle} />
              </BusySwap>
            )}
          </Animated.View>
        )}
      </Pressable>
    </View>
  );
}

const SPINNER = { box: 12, stroke: 1.5, trackAlpha: 0.3 } as const;

function BusySwap({ busy, color, children }: { busy: boolean; color: string; children: ReactNode }) {
  const shown = useRef(new Animated.Value(busy ? 1 : 0)).current;
  useEffect(() => {
    const run = Animated.timing(shown, { toValue: busy ? 1 : 0, ...crossfade, useNativeDriver: true });
    run.start();
    return () => run.stop();
  }, [busy]);
  return (
    <View>
      <Animated.View style={{ opacity: shown.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }}>{children}</Animated.View>
      {busy ? (
        <Animated.View pointerEvents="none" style={[BUSY_OVERLAY, { opacity: shown }]}>
          <ButtonSpinner color={color} />
        </Animated.View>
      ) : null}
    </View>
  );
}

const BUSY_OVERLAY = { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" } as const;

export function ButtonSpinner({ color, box = SPINNER.box, stroke = SPINNER.stroke }: { color: string; box?: number; stroke?: number }) {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: period.spinner, easing: curve.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, []);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: box,
        height: box,
        borderRadius: box / 2,
        borderWidth: stroke,
        borderColor: withAlpha(color, SPINNER.trackAlpha),
        borderTopColor: color,
        transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }],
      }}
    />
  );
}
