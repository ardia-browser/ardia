import { type ReactNode } from "react";
import { tapActivates } from "./a11y";
import { Surface, VisualEffect } from "@ardia/shell";
import { Symbol } from "./Symbol";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { useHover } from "./useHover";
import { HoverFill, HoverSwap } from "./HoverFill";
import { hex, useTheme, type Theme } from "./theme";
import { capsule, closeOnArt, opacity, pillHeight, radius as radii, space, stepperSize, font as typeScale, weight as weights } from "./tokens";
import { buttonMotion, usePressScaleMotion } from "./motion";
import { useLiveWhile, useClosing } from "./Closing";
import { useControlSize } from "./controlSize";
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
  const closing = useClosing();
  const live = useLiveWhile(closing);
  return (
    <View {...hoverProps} style={{ opacity: disabled ? opacity.disabled : 1 }}>
      <Pressable disabled={disabled || closing} onPress={live(onPress)} onAccessibilityTap={disabled || closing ? undefined : tapActivates(live(onPress))} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut} tooltip={tooltip} accessibilityRole="button" accessibilityLabel={tooltip}>
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
            <HoverSwap shown={!disabled && (pressed || hovered)} rest={theme.control} color={pressed ? theme.controlPressed : theme.controlHover} instant={pressed} radius={radii.control} underBorder={StyleSheet.hairlineWidth * 2} />
            <ScaledGlyph scale={pressMotion.scale} size={12}><Symbol name={icon} size={10} weight="semibold" color={theme.icon} style={{ width: 12, height: 12 }} /></ScaledGlyph>
          </View>
        )}
      </Pressable>
    </View>
  );
}

const CHIP_DIM = 0.85;

export function PillButtonView(props: PillProps) {
  const { onPress, title, primary = false, size } = props;
  const theme = useTheme();
  const closing = useClosing();
  const live = useLiveWhile(closing);
  const { hovered, hoverProps } = useHover();
  const pressMotion = usePressScaleMotion(true, buttonMotion.controlPressScale);
  const scaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : null;
  if (props.tone === "chip") {
    const { icon, tone } = props;
    const chipHeight = props.height ?? pillHeight[size ?? "m"];
    return (
      <View {...hoverProps}>
        <Pressable
          disabled={closing}
          onPress={live(onPress)}
          onAccessibilityTap={tapActivates(live(onPress))}
          onPressIn={pressMotion.onPressIn}
          onPressOut={pressMotion.onPressOut}
          accessibilityRole="button"
          accessibilityLabel={title}
          onFocus={props.onFocusChange ? () => props.onFocusChange?.(true) : undefined}
          onBlur={props.onFocusChange ? () => props.onFocusChange?.(false) : undefined}
        >
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
                <HoverSwap shown={pressed || hovered} rest={rest.fill} color={look.fill} instant={pressed} radius={capsule(chipHeight)} />
                {icon ? <Symbol name={icon} size={10.5} weight="semibold" color={ink} style={{ width: 14, height: 14 }} /> : null}
                <Text style={{ ...typeScale.small, fontWeight: weights.medium, color: ink }}>{title}</Text>
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
        disabled={disabled || closing}
        onPress={live(onPress)} onAccessibilityTap={disabled || closing ? undefined : tapActivates(live(onPress))}
        onPressIn={pressMotion.onPressIn}
        onPressOut={pressMotion.onPressOut}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
      >
        {({ pressed }) => {
          const look = pillLook(theme, "prompt", primary, !disabled && pressed, !disabled && hovered);
          return (
            <Animated.View style={[{ height, paddingHorizontal: space.l, alignItems: "center", justifyContent: "center" }, scaleStyle]}>
              <HoverSwap shown={!disabled && (pressed || hovered)} rest={pillLook(theme, "prompt", primary, false, false).fill} color={look.fill} instant={pressed} radius={size ? capsule(height) : radii.tile} />
              <Text numberOfLines={1} style={{ ...typeScale.body, fontWeight: weights.medium, color: look.text }}>
                {title}
              </Text>
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
  const closing = useClosing();
  const live = useLiveWhile(closing);
  if (look === "panel")
    return (
      <View {...hoverProps} style={style} tooltip={tooltip}>
        <Pressable disabled={closing} onPress={live(onPress)} onAccessibilityTap={tapActivates(live(onPress))} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut} accessibilityRole="button" accessibilityLabel={label ?? tooltip}>
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
        <Pressable disabled={closing} onPress={live(onPress)} onAccessibilityTap={tapActivates(live(onPress))} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut} accessibilityRole="button" accessibilityLabel={label ?? tooltip}>
          {({ pressed }) => (
            <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
              <HoverSwap shown={pressed || hovered} rest={closeOnArt.rest} color={pressed ? closeOnArt.pressed : closeOnArt.hover} instant={pressed} radius={corner} />
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
      <Pressable disabled={closing} onPress={live(onPress)} onAccessibilityTap={tapActivates(live(onPress))} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut} accessibilityRole="button" accessibilityLabel={label ?? tooltip}>
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

export function PushButtonView({ title, onPress, kind = "default", disabled, icon, style }: PushProps) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const pressMotion = usePressScaleMotion(!disabled, buttonMotion.controlPressScale);
  const scaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : null;
  const closing = useClosing();
  const live = useLiveWhile(closing);
  const sized = useControlSize();
  const dead = !!disabled || closing;
  const primary = kind === "primary";
  const plain = kind === "plain";
  const textColor = primary ? theme.onAccent : kind === "destructive" ? theme.destructive : plain ? theme.formAccent : theme.textPrimary;
  return (
    <View {...hoverProps} style={[{ opacity: disabled ? opacity.disabled : 1 }, style]}>
      <Pressable
        disabled={dead}
        onPress={live(onPress)}
        onAccessibilityTap={dead ? undefined : live(onPress)}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ disabled: !!disabled }}
        onPressIn={pressMotion.onPressIn}
        onPressOut={pressMotion.onPressOut}
      >
        {({ pressed }) => (
          <Animated.View
            style={[{
              height: plain ? undefined : sized.button,
              borderRadius: sized.radius,
              paddingHorizontal: plain ? 0 : sized.buttonPad,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: space.xs,
              backgroundColor: primary ? (pressed ? theme.formAccentPressed : theme.formAccent) : undefined,
              borderWidth: plain || primary ? 0 : StyleSheet.hairlineWidth * 2,
              borderColor: theme.controlBorder,
            }, scaleStyle]}
          >
            {plain || primary ? null : <HoverSwap shown={!disabled && (pressed || hovered)} rest={theme.control} color={pressed ? theme.controlPressed : theme.controlHover} instant={pressed} radius={sized.radius} underBorder={StyleSheet.hairlineWidth * 2} />}
            {icon ? <Symbol name={icon} size={11} color={textColor} style={{ width: 13, height: 13 }} /> : null}
            <Text ardiaCentersCapitals={!plain} style={{ ...typeScale.body, color: textColor, textDecorationLine: plain && hovered ? "underline" : "none" }}>{title}</Text>
          </Animated.View>
        )}
      </Pressable>
    </View>
  );
}
