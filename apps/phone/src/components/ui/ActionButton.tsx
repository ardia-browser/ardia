import type { RefObject } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewInstance } from "react-native";
import { ChromeFrost } from "./LookViews";
import { usePressStyle } from "./pressFeedback";
import { Symbol } from "./Symbol";
import type { SymbolName } from "./symbolPaths";
import { useTheme, type Theme } from "./theme";
import { actionLayout, actionRoleOf, capsule as capsuleRadius, ink, overlayInk, primaryActionRoles, smoothCorners, type ActionSize } from "./tokens";

export type ActionVariant = "filled" | "outlined" | "plain" | "glass";

export type ActionTone = "accent" | "neutral" | "overlay" | "ink";

export type ActionInk = { fill: string; label: string; edge: string };

export function actionInk(theme: Pick<Theme, "spaceAccent" | "spaceAccentInk" | "onSpaceAccent" | "secondaryFill" | "label" | "separator" | "pageSurface">, variant: ActionVariant, tone: ActionTone): ActionInk {
  if (tone === "ink") return variant === "filled" ? { fill: theme.label, label: theme.pageSurface, edge: ink.clear } : { fill: ink.clear, label: theme.label, edge: variant === "outlined" ? theme.label : ink.clear };
  if (variant === "glass") return { fill: overlayInk.glass, label: overlayInk.label, edge: ink.clear };
  if (tone === "overlay") {
    if (variant === "filled") return { fill: overlayInk.fill, label: overlayInk.onFill, edge: ink.clear };
    return { fill: ink.clear, label: overlayInk.label, edge: variant === "outlined" ? overlayInk.edge : ink.clear };
  }
  if (variant === "filled") return tone === "accent" ? { fill: theme[primaryActionRoles.full.fill], label: theme[primaryActionRoles.full.ink], edge: ink.clear } : { fill: theme.secondaryFill, label: theme.label, edge: ink.clear };
  const label = tone === "accent" ? theme.spaceAccentInk : theme.label;
  return { fill: ink.clear, label, edge: variant === "outlined" ? (tone === "accent" ? theme.spaceAccentInk : theme.separator) : ink.clear };
}

export type ActionButtonProps = {
  title: string;
  onPress: () => void;
  variant?: ActionVariant;
  tone?: ActionTone;
  size?: ActionSize;
  icon?: SymbolName;
  busy?: boolean;
  disabled?: boolean;
  hint?: string;
  stretch?: boolean;
  capsule?: boolean;
  frostSource?: string;
  buttonRef?: RefObject<ViewInstance | null>;
  ink?: ActionInk;
  testID?: string;
};

export function ActionButton({ title, onPress, variant = "filled", tone = "accent", size = "regular", icon, busy = false, disabled = false, hint, stretch = false, capsule = false, frostSource, buttonRef, ink: chosenInk, testID }: ActionButtonProps) {
  const theme = useTheme();
  const colors = chosenInk ?? actionInk(theme, variant, tone);
  const role = primaryActionRoles[actionRoleOf[size]];
  const cornerRadius = capsule ? capsuleRadius(role.height) : role.radius;
  const frosted = variant === "glass" && frostSource !== undefined;
  const box = {
    minHeight: role.height,
    borderRadius: cornerRadius,
    paddingHorizontal: actionLayout.sidePadding[size],
    backgroundColor: frosted ? ink.clear : colors.fill,
    borderColor: colors.edge,
    borderWidth: variant === "outlined" ? actionLayout.edge : 0,
  };
  const pressStyle = usePressStyle(variant === "filled" || variant === "glass" ? "filled" : "text", { disabled, style: [styles.button, box, variant === "glass" ? styles.plate : null, stretch ? styles.stretch : null] });
  return (
    <Pressable
      ref={buttonRef}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={hint}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={pressStyle}
    >
      {frosted ? <ChromeFrost source={frostSource} variant="glass" dark cornerRadius={cornerRadius} fill={colors.fill} solidFill={overlayInk.solidGlass} style={StyleSheet.absoluteFill} /> : null}
      <View style={[styles.content, busy ? styles.hidden : null]}>
        {icon ? <Symbol name={icon} size={actionLayout.icon[size]} color={colors.label} /> : null}
        <Text style={[actionLayout.label[size], styles.label, { color: colors.label }]}>{title}</Text>
      </View>
      {busy ? <ActivityIndicator testID={testID ? `${testID}Busy` : undefined} color={colors.label} style={StyleSheet.absoluteFill} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { alignItems: "center", justifyContent: "center", paddingVertical: actionLayout.verticalPadding, ...smoothCorners },
  stretch: { alignSelf: "stretch" },
  plate: { overflow: "hidden" },
  content: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: actionLayout.iconGap },
  hidden: { opacity: 0 },
  label: { fontWeight: actionLayout.labelWeight, textAlign: "center", flexShrink: 1 },
});
