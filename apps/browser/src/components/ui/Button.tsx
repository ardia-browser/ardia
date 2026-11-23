import { ContextMenuArea } from "@ardia/shell";
import { drawnSymbol, type SymbolProps } from "./Symbol";
import { memo, useState, type ReactNode } from "react";
import { Animated, Image, Pressable, Text, View, type GestureResponderEvent, type ImageSourcePropType, type StyleProp, type ViewStyle } from "react-native";
import { modifiersOf, type ClickModifiers } from "../../lib/keys";
import { useToolbarRowContext } from "./toolbarRowContext";
import { useHover, useTooltip } from "./useHover";
import { HoverFill } from "./HoverFill";
import { tintedImage } from "./TintedImage";
import { CloseButtonView, PillButtonView, PushButtonView, StepperButtonView, TitleSwap } from "./ButtonKinds";
import { useTheme } from "./theme";
import { buttonMotion, usePressMotion, usePressScaleMotion } from "./motion";
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
  reserve?: readonly string[];
};

export type PillSize = "m" | "l" | "xl";

export type PillProps = { variant: "pill"; onPress: () => void; title: string; primary?: boolean; size?: PillSize; reserve?: readonly string[] } & ({ tone?: "prompt"; disabled?: boolean } | { tone: "chip"; icon?: string; height?: number });

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
  reserve?: readonly string[];
  busy?: boolean;
  label?: string;
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
  const { icon, disabled, active, glyphBox, weight = "regular", tooltip, palette, color, style, hit, image, asset, badge, children } = props;
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const tip = useTooltip(tooltip);
  const metrics = useIconMetrics(props);
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
    props.onPressIn?.(event);
  };
  const handlePressOut = (event: GestureResponderEvent) => props.onPressOut?.(event);
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
      {lit ? <HoverFill shown={!disabled && (pressed || !!active || hovered)} instant={!!active} color={pressed || active ? pressedFill : hover} radius={plateRadius} /> : null}
      {face}
      {badge}
    </View>
  );
  if (!props.toolbar)
    return (
      <View tooltip={tip} style={style} {...hoverProps}>
        <Pressable onPress={props.onPress} onPressIn={handlePressIn} onPressOut={handlePressOut} disabled={disabled} accessibilityRole="button" accessibilityLabel={tooltip} style={hit ? { width: hit.width, height: hit.height } : undefined}>
          {({ pressed }) => plate(pressed)}
        </Pressable>
      </View>
    );
  const { onPress, onLongPress, onContextMenu } = props;
  const button = (
    <Pressable
      onPress={(e) => onPress?.(modifiersOf(e))}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onLongPress={onLongPress}
      delayLongPress={450}
      disabled={disabled}
      accessibilityLabel={tooltip}
      style={hit ? { width: hit.width, height: hit.height } : undefined}
    >
      {({ pressed }) => plate(pressed)}
    </Pressable>
  );
  return (
    <View tooltip={tip} style={style} mouseDownCanMoveWindow={false} {...hoverProps}>
      {onContextMenu && !disabled ? <ContextMenuArea onContextMenu={onContextMenu}>{button}</ContextMenuArea> : button}
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
  const { title, onPress, disabled, look, hoverTone, padY, label, reserve } = props;
  const base = look ? TEXT_LOOKS[look] : null;
  const plate = props.plate ?? base?.plate ?? "toolbar";
  const height = props.height ?? base?.height;
  const pad = props.pad ?? base?.pad ?? "m";
  const size = props.size ?? base?.size ?? "small";
  const weight = props.weight ?? base?.weight ?? "medium";
  const tone = props.tone ?? base?.tone ?? "textPrimary";
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
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
  const a11y = label ? ({ accessibilityRole: "button", accessibilityLabel: label } as const) : undefined;
  const textStyle = (color: string) => ({ ...typeScale[size], ...(weight === "regular" ? null : { fontWeight: weights[weight] }), color });
  if (plate === "none")
    return (
      <View {...hoverProps}>
        <Pressable onPress={onPress} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut} disabled={disabled} {...a11y}>
          {reserve?.length ? (
            <Plate style={scaleStyle}>
              <TitleSwap title={title} reserve={reserve} style={[textStyle(!disabled && hovered && hoverTone ? theme[hoverTone] : theme[tone]), { paddingVertical: padY ? space[padY] : undefined }, look === "link" && !disabled && hovered ? UNDERLINE : null]} />
            </Plate>
          ) : (
            <Label style={[textStyle(!disabled && hovered && hoverTone ? theme[hoverTone] : theme[tone]), { paddingVertical: padY ? space[padY] : undefined }, look === "link" && !disabled && hovered ? UNDERLINE : null, scaleStyle]}>{title}</Label>
          )}
        </Pressable>
      </View>
    );
  const shows = (pressed: boolean) => !disabled && ((plate === "toolbar" && pressed) || hovered);
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress} onPressIn={pressIn} onPressOut={pressMotion.onPressOut} disabled={disabled} {...a11y}>
        {({ pressed }) => (
          <Plate style={[{ height, paddingHorizontal: space[pad], justifyContent: "center" }, scaleStyle]}>
            {lit ? <HoverFill shown={shows(pressed)} color={plate === "toolbar" && pressed ? theme.toolbarPressed : theme.toolbarHover} radius={radii.control} /> : null}
            <TitleSwap title={title} reserve={reserve} style={textStyle(disabled ? theme.iconDisabled : hovered && hoverTone ? theme[hoverTone] : theme[tone])} />
          </Plate>
        )}
      </Pressable>
    </View>
  );
}
