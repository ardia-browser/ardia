import { devRegister } from "../dev/devRegister";
import { useEffect } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { PERSONALIZE_COPY, TabLayoutPicker } from "../onboarding/Personalize";
import { ThemePicker } from "../settings/ThemeEditor";
import { Box, capsule, ClosingView, useLiveWhile, PopoverSurface, proseLineHeight, space, Symbol, Text, useHover, usePopoverMotion, usePopoverMotionStyle, usePopoverPresence, useTheme, tapActivates } from "../ui";
import { closePersonalizePanelOf, setPersonalizePanel as setOpen, usePersonalizePanel } from "../../state/pages/personalizePanel";
import { buttonMotion, usePressScaleMotion } from "../ui/motion";
import { perLook } from "../ui/tokens";

const INSET = space.xl;
const BUTTON = 30;
const GLYPH_DROP = 1.5;
const PANEL_WIDTH = 432;

export function PersonalizeButton({ windowId }: { windowId: string }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const pressMotion = usePressScaleMotion(true, buttonMotion.iconPressScale);
  const open = usePersonalizePanel((s) => s.windowId === windowId);
  const { shown, closing, onClosed } = usePopoverPresence(open);
  useEffect(() => () => closePersonalizePanelOf(windowId), [windowId]);
  return (
    <>
      {shown ? <PersonalizePanel windowId={windowId} onClose={() => setOpen(null)} closing={closing} onClosed={onClosed} /> : null}
      <View {...hoverProps} tooltip="Personalize" style={{ position: "absolute", right: INSET, bottom: INSET - GLYPH_DROP }}>
        <Pressable
          onPress={() => setOpen(open ? null : windowId)} onAccessibilityTap={tapActivates(() => setOpen(open ? null : windowId))}
          onPressIn={pressMotion.onPressIn}
          onPressOut={pressMotion.onPressOut}
          accessibilityRole="button"
          accessibilityLabel="Personalize"
          accessibilityState={{ expanded: open }}
        >
          {({ pressed }) => (
            <View
              style={{
                width: BUTTON,
                height: BUTTON,
                borderRadius: capsule(BUTTON),
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: pressed ? theme.toolbarPressed : hovered || open ? theme.toolbarHover : undefined,
              }}
            >
              <Animated.View style={[PERSONALIZE_GLYPH, pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : null]}>
                <Symbol name="paintpalette" size={14} color={hovered || open ? theme.icon : theme.textTertiary} style={PERSONALIZE_GLYPH} />
              </Animated.View>
            </View>
          )}
        </Pressable>
      </View>
    </>
  );
}

const PERSONALIZE_GLYPH = { width: BUTTON, height: BUTTON, alignItems: "center", justifyContent: "center" } as const;

function PersonalizePanel({ windowId, onClose, closing, onClosed }: { windowId: string; onClose: () => void; closing: boolean; onClosed: () => void }) {
  const appear = usePopoverMotion(closing, onClosed);
  const motion = usePopoverMotionStyle(appear, "bottom right", true);
  const live = useLiveWhile(closing);
  return (
    <>
      {closing ? null : <Pressable style={StyleSheet.absoluteFill} onPress={live(onClose)} accessibilityLabel="Close Personalize" />}
      <ClosingView
        closing={closing}
        style={{
          position: "absolute",
          right: INSET,
          bottom: INSET + BUTTON + space.m,
          width: PANEL_WIDTH,
          ...motion,
        }}
      >
        <PopoverSurface>
          <Box pad="xl" gap="xl">
            <Box gap="xs">
              <Text size="title" weight="semibold">
                {PERSONALIZE_COPY.title}
              </Text>
              <Text size="small" tone="textSecondary" style={SUBTITLE()}>
                {PERSONALIZE_COPY.subtitle}
              </Text>
            </Box>
            <ThemePicker windowId={windowId} size={28} gap={space.xs} />
            <Box gap="m">
              <Text size="small" tone="textSecondary">
                {PERSONALIZE_COPY.layouts}
              </Text>
              <TabLayoutPicker windowId={windowId} />
            </Box>
          </Box>
        </PopoverSurface>
      </ClosingView>
    </>
  );
}

const SUBTITLE = perLook(() => ({ lineHeight: proseLineHeight.small }) as const);

devRegister("acPersonalize", "open", setOpen);
