import { memo } from "react";
import { Animated, Pressable, View } from "react-native";
import { Symbol, useHover } from "../ui";
import { useTheme } from "../ui/theme";
import { WINDOW_CHROME, WINDOW_CONTROLS, windowButtonsChoosable, windowButtonsFor, windowControlsDrawn, windowControlsWidth, type WindowButton } from "../../lib/windowChrome";
import { useWindowChrome } from "../../state/windows/windowButtons";
import { useWindowMaximized } from "../../state/windows/captionRegions";
import { WINDOW_BUTTONS } from "./tokens";
import { closeFromWindowControls, minimizeWindow, toggleWindowMaximized } from "../../state/windows/controls";
import { t } from "../../lib/uiLanguage";


const B = WINDOW_BUTTONS;

type Ink = { icon: string; hover: string; pressed: string };
type Kind = "menu" | "minimize" | "maximize" | "restore" | "close";

const LABEL: Record<Kind, string> = { menu: t(`Menu`), minimize: t(`Minimize`), maximize: t(`Maximize`), restore: t(`Restore Down`), close: t(`Close`) };

function Glyph({ kind, color, box }: { kind: Kind; color: string; box: number }) {
  if (kind === "menu") return <Symbol name="ellipsis" size={box + 4} weight="regular" color={color} style={{ width: box + 6, height: box + 6 }} />;
  if (kind === "minimize") return <View style={{ width: box, height: 1, backgroundColor: color }} />;
  if (kind === "maximize") return <View style={{ width: box, height: box, borderWidth: 1, borderRadius: B.glyphRadius, borderColor: color }} />;
  if (kind === "restore") {
    const pane = box - 2;
    return (
      <View style={{ width: box, height: box }}>
        <View style={{ position: "absolute", right: 0, top: 0, width: pane, height: pane, borderTopWidth: 1, borderRightWidth: 1, borderTopRightRadius: B.restoreCorner, borderColor: color }} />
        <View style={{ position: "absolute", left: 0, bottom: 0, width: pane, height: pane, borderWidth: 1, borderRadius: B.glyphRadius, borderColor: color }} />
      </View>
    );
  }
  return <Symbol name="xmark" size={box} weight="regular" color={color} style={{ width: box + 4, height: box + 4 }} />;
}

function ControlButton({ kind, width, height, radius, ink, onPress }: { kind: Kind; width: number; height: number; radius: number; ink: Ink; onPress: () => void }) {
  const { hovered, hoverProps } = useHover();
  const close = kind === "close";
  return (
    <View {...hoverProps}>
      <Pressable focusable onPress={onPress} accessibilityRole="button" accessibilityLabel={LABEL[kind]}>
        {({ pressed }) => (
          <View
            style={{
              width,
              height,
              borderRadius: radius,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed ? (close ? B.closePressed : ink.pressed) : hovered ? (close ? B.closeHover : ink.hover) : undefined,
            }}
          >
            <Glyph kind={kind} color={close && (hovered || pressed) ? B.closeInk : ink.icon} box={height < B.smallBelow ? B.smallGlyph : B.glyph} />
          </View>
        )}
      </Pressable>
    </View>
  );
}

export type WindowControlsProps = {
  windowId: string;
  centerY: number;
  size: number;
  maximizable?: boolean;
  minimizable?: boolean;
  onMenu?: () => void;
  ink?: Partial<Ink>;
  opacity?: Animated.AnimatedInterpolation<number> | number;
  hidden?: boolean;
  leading?: boolean;
  inset?: number;
  buttons?: readonly WindowButton[];
};

export const controlsShown = windowControlsDrawn() || windowButtonsChoosable;

const pressOf = (button: WindowButton, windowId: string, onMenu: (() => void) | undefined): (() => void) =>
  button === "menu" ? (onMenu ?? (() => {})) : button === "minimize" ? () => minimizeWindow(windowId) : button === "maximize" ? () => toggleWindowMaximized(windowId) : () => closeFromWindowControls(windowId);

export const useControlsShown = (): boolean => {
  useWindowChrome();
  return windowControlsDrawn();
};

export const WindowControls = memo(function WindowControls({ windowId, centerY, size, maximizable = true, minimizable = true, onMenu, ink, opacity = 1, hidden = false, leading = false, inset = WINDOW_CONTROLS.edge, buttons }: WindowControlsProps) {
  const theme = useTheme();
  const maximized = useWindowMaximized(windowId);
  const shown = useControlsShown();
  const drawn = windowButtonsFor(buttons ?? WINDOW_CHROME.trailingButtons, { menu: !!onMenu, minimizable, maximizable });
  if (!shown || !drawn.length) return null;
  const colors: Ink = { icon: ink?.icon ?? theme.icon, hover: ink?.hover ?? theme.toolbarHover, pressed: ink?.pressed ?? theme.toolbarPressed };
  const width = WINDOW_CONTROLS.button;
  const plateRadius = Math.min(B.plateRadius.most, Math.round(size / B.plateRadius.share));
  return (
    <Animated.View
      pointerEvents={hidden ? "none" : "box-none"}
      style={{
        position: "absolute",
        [leading ? "left" : "right"]: inset,
        top: centerY - size / 2,
        width: windowControlsWidth(drawn.length),
        height: size,
        flexDirection: "row",
        gap: WINDOW_CONTROLS.gap,
        opacity,
      }}
    >
      {drawn.map((button) => (
        <ControlButton key={button} kind={button === "maximize" && maximized ? "restore" : button} width={width} height={size} radius={plateRadius} ink={colors} onPress={pressOf(button, windowId, onMenu)} />
      ))}
    </Animated.View>
  );
});
