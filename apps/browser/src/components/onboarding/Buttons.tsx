import type { ReactNode, Ref } from "react";
import { Animated, Pressable, View } from "react-native";
import { GlassFill, Symbol, Text, useGlass, useHover, type SymbolProps } from "../ui";
import { ink, space } from "../ui/tokens";
import { useOnboardingColors } from "./Parts";
import { onboardingButton } from "./tokens";
import { usePressScaleMotion } from "../ui/motion";

function PressScale({ title, onPress, disabled, scale, tooltip, pressRef, children }: { title: string; onPress: () => void; disabled?: boolean; scale: number; tooltip?: string; pressRef?: Ref<View>; children: (state: { hovered: boolean; pressed: boolean }) => ReactNode }) {
  const { hovered, hoverProps } = useHover();
  const pressMotion = usePressScaleMotion(!disabled, scale);
  const scaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : undefined;
  return (
    <View {...hoverProps} tooltip={tooltip} style={disabled === undefined ? undefined : { opacity: disabled ? onboardingButton.disabledOpacity : 1 }}>
      <Pressable
        ref={pressRef}
        disabled={disabled}
        onPress={onPress}
        onAccessibilityTap={disabled ? undefined : onPress}
        onPressIn={pressMotion.onPressIn}
        onPressOut={pressMotion.onPressOut}
        accessibilityRole="button"
        accessibilityLabel={title}
      >
        {({ pressed }) => (
          <Animated.View mouseDownCanMoveWindow={false} style={scaleStyle}>
            {children({ hovered, pressed })}
          </Animated.View>
        )}
      </Pressable>
    </View>
  );
}

export function PrimaryButton({ title, onPress, disabled, icon }: { title: string; onPress: () => void; disabled?: boolean; icon?: string }) {
  const colors = useOnboardingColors();
  const glass = useGlass();
  return (
    <PressScale title={title} onPress={onPress} disabled={!!disabled} scale={onboardingButton.pressScale}>
      {({ hovered }) => (
        <View
          style={{
            height: onboardingButton.height,
            borderRadius: onboardingButton.height / 2,
            paddingHorizontal: onboardingButton.primaryPad,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: space.s,
            backgroundColor: glass ? ink.clear : hovered && !disabled ? colors.primaryHover : colors.primary,
          }}
        >
          {glass ? <GlassFill radius={onboardingButton.height / 2} panelFill={hovered && !disabled ? colors.primaryHover : colors.primary} /> : null}
          <Text weight="semibold" color={colors.primaryText} ardiaCentersCapitals>
            {title}
          </Text>
          {icon ? <Symbol name={icon} size={11} weight="semibold" color={colors.primaryText} style={{ width: 12, height: 12 }} /> : null}
        </View>
      )}
    </PressScale>
  );
}

export function SecondaryButton({ title, onPress, filled, pressRef }: { title: string; onPress: () => void; filled?: boolean; pressRef?: Ref<View> }) {
  const colors = useOnboardingColors();
  const glass = useGlass();
  return (
    <PressScale title={title} onPress={onPress} scale={onboardingButton.pressScale} pressRef={pressRef}>
      {({ hovered }) => (
        <View
          style={{
            height: onboardingButton.height,
            borderRadius: onboardingButton.height / 2,
            paddingHorizontal: onboardingButton.secondaryPad,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: glass ? ink.clear : filled ? (hovered ? colors.buttonHover : colors.button) : hovered ? colors.outlinedHover : ink.clear,
            borderWidth: filled || glass ? 0 : 1,
            borderColor: colors.noThanksBorder,
          }}
        >
          {glass ? <GlassFill radius={onboardingButton.height / 2} state={hovered ? "lit" : "rest"} /> : null}
          <Text weight="medium" color={filled ? colors.buttonText : colors.noThanksText} ardiaCentersCapitals>
            {title}
          </Text>
        </View>
      )}
    </PressScale>
  );
}

export function CircleButton({
  title,
  icon,
  size,
  symbolWeight,
  box,
  tooltip,
  onPress,
  pressRef,
}: {
  title: string;
  icon: string;
  size: number;
  symbolWeight: SymbolProps["weight"];
  box: number;
  tooltip?: string;
  onPress: () => void;
  pressRef?: Ref<View>;
}) {
  const colors = useOnboardingColors();
  const glass = useGlass();
  return (
    <PressScale title={title} onPress={onPress} scale={onboardingButton.circlePressScale} tooltip={tooltip} pressRef={pressRef}>
      {({ hovered }) => (
        <View
          style={{
            width: onboardingButton.height,
            height: onboardingButton.height,
            borderRadius: onboardingButton.height / 2,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: glass ? ink.clear : hovered ? colors.outlinedHover : ink.clear,
            borderWidth: glass ? 0 : 1,
            borderColor: colors.noThanksBorder,
          }}
        >
          {glass ? <GlassFill radius={onboardingButton.height / 2} state={hovered ? "lit" : "rest"} /> : null}
          <Symbol name={icon} size={size} weight={symbolWeight} color={colors.noThanksText} style={{ width: box, height: box }} />
        </View>
      )}
    </PressScale>
  );
}

export function BackButton({ onPress }: { onPress: () => void }) {
  return <CircleButton title="Back" icon="chevron.left" size={12} symbolWeight="semibold" box={14} onPress={onPress} />;
}
