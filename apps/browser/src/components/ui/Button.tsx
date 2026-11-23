import { ContextMenuArea } from "@ardia/shell";
import { tapActivates } from "./a11y";
import { drawnSymbol, type SymbolProps } from "./Symbol";
import { memo, useState, type ReactNode } from "react";
import { Animated, Image, Pressable, Text, View, type GestureResponderEvent, type ImageSourcePropType, type StyleProp, type ViewStyle } from "react-native";
import { modifiersOf, type ClickModifiers } from "../../lib/keys";
import { useToolbarRowContext } from "./toolbarRowContext";
import { useHover, useTooltip } from "./useHover";
import { HoverFill } from "./HoverFill";
import { tintedImage } from "./TintedImage";
import { CloseButtonView, PillButtonView, PushButtonView, StepperButtonView } from "./ButtonKinds";
import { useTheme } from "./theme";
import { buttonMotion, usePressMotion, usePressScaleMotion } from "./motion";
import { useLiveWhile, useClosing } from "./Closing";
import { capsule, iconButton, opacity, radius as radii, space, font as typeScale, weight as weights, type ColorRole, type IconButtonSize, type Space, type TypeSize, type Weight } from "./tokens";

export type ButtonHit = { width: number; height: number; plateX: number; plateY: number; box?: number; radius?: number };

export type IconPalette = { icon: string; iconDisabled: string; hover: string; pressed: string };

type IconBase = {
  variant: "icon";
  icon?: string;
  disabled?: boolean;
  active?: boolean;
  size?: IconButtonSize;
  glyph?: number;
  look?: "field" | "row" | "extension";
  capsule?: boolean;
  image?: string;
  asset?: ImageSourcePropType;
  badge?: ReactNode;
  children?: ReactNode;
  box?: number;
  glyphBox?: number;
  radius?: number;
  weight?: SymbolProps["weight"];
  tooltip?: string;
  focusable?: boolean;
  palette?: IconPalette;
  color?: string;
  style?: StyleProp<ViewStyle>;
  hit?: ButtonHit;
  onPressIn?: (event: GestureResponderEvent) => void;
  onPressOut?: (event: GestureResponderEvent) => void;
};

type IconProps = IconBase &
  ({ toolbar?: false; onPress?: (press: GestureResponderEvent) => void } | { toolbar: true; onPress?: (modifiers: ClickModifiers) => void; onLongPress?: () => void; onContextMenu?: () => void });

type TextLook = "toolbar" | "panel" | "link";

type TextProps = {
  variant: "text";
  title: string;
  onPress: () => void;
  disabled?: boolean;
  look?: TextLook;
  plate?: "toolbar" | "hover" | "none";
  height?: number;
  pad?: Space;
  padY?: Space;
  size?: TypeSize;
  weight?: Weight;
  tone?: ColorRole;
  hoverTone?: ColorRole;
  label?: string;
  focusable?: boolean;
};

type PillSize = "m" | "l" | "xl";

export type PillProps = { variant: "pill"; onPress: () => void; title: string; primary?: boolean; size?: PillSize } & ({ tone?: "prompt"; disabled?: boolean } | { tone: "chip"; icon?: string; height?: number; onFocusChange?: (focused: boolean) => void });

export type StepperProps = { variant: "stepper"; icon: string; onPress: () => void; width?: number; height?: number; tooltip: string; disabled?: boolean };

export type CloseProps = { variant: "close"; onPress: () => void; tooltip?: string; label?: string; style?: StyleProp<ViewStyle> } & (
  | { look: "hud" | "panel" }
  | { look: "art"; box?: number; radius?: number }
);

export type PushProps = {
  variant?: "push";
  title: string;
  onPress: () => void;
  kind?: "default" | "primary" | "destructive" | "plain";
  disabled?: boolean;
  icon?: string;
  style?: StyleProp<ViewStyle>;
};

export type ButtonProps = IconProps | TextProps | PillProps | StepperProps | CloseProps | PushProps;

export const Button = memo(function Button(props: ButtonProps) {
  switch (props.variant) {
    case "icon":
      return <IconButtonView {...props} />;
    case "text":
      return <TextButtonView {...props} />;
    case "pill":
      return <PillButtonView {...props} />;
    case "stepper":
      return <StepperButtonView {...props} />;
    case "close":
      return <CloseButtonView {...props} />;
    default:
      return <PushButtonView {...props} />;
  }
});

const ROW_GLYPH = 13;
const EXTENSION_GLYPH = 14;
const IMAGE_SIZE = 16;

function useIconMetrics(props: IconProps) {
  const row = useToolbarRowContext();
  if (props.look === "field") return { box: props.box ?? row.fieldButton, glyph: props.glyph ?? ROW_GLYPH, radius: props.radius ?? row.fieldButtonRadius };
  if (props.look === "row") return { box: props.box ?? row.button, glyph: props.glyph ?? ROW_GLYPH, radius: props.radius ?? row.buttonRadius };
  if (props.look === "extension") return { box: props.box ?? row.extensionButton, glyph: props.glyph ?? EXTENSION_GLYPH, radius: props.radius ?? row.buttonRadius };
  const size = props.size ?? "toolbar";
  const step = iconButton[size];
  return { box: props.box ?? step.box, glyph: props.glyph ?? step.glyph, radius: props.radius ?? (size === "toolbar" ? radii.toolbar : radii.control) };
}

function IconButtonView(props: IconProps) {
  const { icon, disabled, active, glyphBox, weight = "regular", tooltip, focusable, palette, color, style, hit, image, asset, badge, children } = props;
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const tip = useTooltip(tooltip);
  const metrics = useIconMetrics(props);
  const closing = useClosing();
  const live = useLiveWhile(closing);
  const dead = !!disabled || closing;
  const hover = palette ? palette.hover : theme.toolbarHover;
  const pressedFill = palette ? palette.pressed : theme.toolbarPressed;
  const plateBox = hit?.box ?? metrics.box;
  const glyphFrame = glyphBox ?? plateBox;
  const ink = color ?? (disabled ? (palette ? palette.iconDisabled : theme.iconDisabled) : palette ? palette.icon : theme.icon);
  const face = children ?? (asset ? (
    <View pointerEvents="none">
      {tintedImage({ source: asset, tint: ink, style: { width: metrics.glyph, height: metrics.glyph } })}
    </View>
  ) : image ? (
    <View pointerEvents="none">
      <Image source={{ uri: image }} style={{ width: IMAGE_SIZE, height: IMAGE_SIZE, opacity: disabled ? opacity.disabled : 1 }} />
    </View>
  ) : icon ? (
    drawnSymbol({ name: icon, size: metrics.glyph, weight, color: ink, style: { width: glyphFrame, height: glyphFrame } })
  ) : null);
  const [lit, setLit] = useState(() => !disabled && !!active);
  if (!lit && !disabled && (hovered || !!active)) setLit(true);
  const handlePressIn = (event: GestureResponderEvent) => {
    if (!lit) setLit(true);
    live(props.onPressIn)?.(event);
  };
  const handlePressOut = (event: GestureResponderEvent) => live(props.onPressOut)?.(event);
  const plateRadius = hit?.radius ?? (props.capsule ? capsule(plateBox) : metrics.radius);
  const plate = (pressed: boolean) => (
    <View
      style={{
        position: hit ? "absolute" : "relative",
        left: hit?.plateX,
        top: hit?.plateY,
        width: plateBox,
        height: plateBox,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {lit ? <HoverFill shown={!disabled && (pressed || !!active || hovered)} instant={!!active || pressed} color={pressed || active ? pressedFill : hover} radius={plateRadius} /> : null}
      {face}
      {badge}
    </View>
  );
  if (!props.toolbar)
    return (
      <View tooltip={tip} style={style} {...hoverProps}>
        <Pressable onPress={live(props.onPress)} onAccessibilityTap={dead ? undefined : tapActivates(live(props.onPress))} onPressIn={handlePressIn} onPressOut={handlePressOut} disabled={dead} focusable={focusable && !dead} accessibilityRole="button" accessibilityLabel={tooltip} style={hit ? { width: hit.width, height: hit.height } : undefined}>
          {({ pressed }) => plate(pressed)}
        </Pressable>
      </View>
    );
  const { onPress, onLongPress, onContextMenu } = props;
  const button = (
    <Pressable
      onPress={live((e) => onPress?.(modifiersOf(e)))} onAccessibilityTap={dead ? undefined : tapActivates(live((e) => onPress?.(modifiersOf(e))))}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onLongPress={live(onLongPress)}
      delayLongPress={450}
      disabled={dead}
      focusable={focusable && !dead}
      accessibilityRole="button"
      accessibilityLabel={tooltip}
      style={hit ? { width: hit.width, height: hit.height } : undefined}
    >
      {({ pressed }) => plate(pressed)}
    </Pressable>
  );
  return (
    <View tooltip={tip} style={style} mouseDownCanMoveWindow={false} {...hoverProps}>
      {onContextMenu && !dead ? <ContextMenuArea onContextMenu={live(onContextMenu)}>{button}</ContextMenuArea> : button}
    </View>
  );
}

const TEXT_LOOKS: Record<TextLook, { plate: "toolbar" | "hover" | "none"; height?: number; pad: Space; size: TypeSize; weight: Weight; tone: ColorRole }> = {
  toolbar: { plate: "toolbar", height: 26, pad: "m", size: "small", weight: "medium", tone: "textPrimary" },
  panel: { plate: "hover", height: 22, pad: "m", size: "small", weight: "regular", tone: "textSecondary" },
  link: { plate: "none", pad: "m", size: "small", weight: "medium", tone: "accent" },
};

const UNDERLINE = { textDecorationLine: "underline" } as const;

function TextButtonView(props: TextProps) {
  const { title, onPress, disabled, look, hoverTone, padY, label, focusable } = props;
  const base = look ? TEXT_LOOKS[look] : null;
  const plate = props.plate ?? base?.plate ?? "toolbar";
  const height = props.height ?? base?.height;
  const pad = props.pad ?? base?.pad ?? "m";
  const size = props.size ?? base?.size ?? "small";
  const weight = props.weight ?? base?.weight ?? "medium";
  const tone = props.tone ?? base?.tone ?? "textPrimary";
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const closing = useClosing();
  const live = useLiveWhile(closing);
  const dead = !!disabled || closing;
  const pressMotion = usePressScaleMotion(usePressMotion() === "bounce", buttonMotion.controlPressScale);
  const scaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : null;
  const [lit, setLit] = useState(false);
  if (!lit && !disabled && hovered) setLit(true);
  const pressIn = () => {
    if (!lit) setLit(true);
    pressMotion.onPressIn?.();
  };
  const Plate = scaleStyle ? Animated.View : View;
  const Label = scaleStyle ? Animated.Text : Text;
  const a11y = { accessibilityRole: "button", accessibilityLabel: label ?? title } as const;
  const textStyle = (color: string) => ({ ...typeScale[size], ...(weight === "regular" ? null : { fontWeight: weights[weight] }), color });
  if (plate === "none")
    return (
      <View {...hoverProps}>
        <Pressable onPress={live(onPress)} onAccessibilityTap={dead ? undefined : tapActivates(live(onPress))} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut} disabled={dead} focusable={focusable && !dead} {...a11y}>
          <Label style={[textStyle(hovered && hoverTone ? theme[hoverTone] : theme[tone]), { paddingVertical: padY ? space[padY] : undefined }, look === "link" && hovered ? UNDERLINE : null, scaleStyle]}>{title}</Label>
        </Pressable>
      </View>
    );
  const shows = (pressed: boolean) => !disabled && (pressed || hovered);
  return (
    <View {...hoverProps}>
      <Pressable onPress={live(onPress)} onAccessibilityTap={dead ? undefined : tapActivates(live(onPress))} onPressIn={pressIn} onPressOut={pressMotion.onPressOut} disabled={dead} focusable={focusable && !dead} {...a11y}>
        {({ pressed }) => (
          <Plate style={[{ height, paddingHorizontal: space[pad], justifyContent: "center" }, scaleStyle]}>
            {lit ? <HoverFill shown={shows(pressed)} instant={pressed} color={pressed ? theme.toolbarPressed : theme.toolbarHover} radius={radii.control} /> : null}
            <Text style={textStyle(disabled ? theme.iconDisabled : hovered && hoverTone ? theme[hoverTone] : theme[tone])}>{title}</Text>
          </Plate>
        )}
      </Pressable>
    </View>
  );
}
