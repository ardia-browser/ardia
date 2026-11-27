import { createContext, useContext, useRef } from "react";
import { Pressable, StyleSheet, Text, View, type ViewInstance } from "react-native";
import { ActionButton, font, smoothCorners, space, Toggle, type ActionInk } from "../ui";
import { CrossfadeText } from "../settings/SettingsKit";
import { brand, textHalo } from "./onboardingTokens";

export const KIT_INK = {
  primary: { fill: brand.paper, label: brand.ink, edge: "transparent" },
  secondary: { fill: "transparent", label: brand.cream, edge: "transparent" },
  primaryLabel: { fill: "transparent", label: brand.ink, edge: "transparent" },
  carriedLabel: { fill: "transparent", label: "transparent", edge: "transparent" },
} as const satisfies Record<string, ActionInk>;

export type SlotRect = { x: number; y: number; width: number; height: number };

export type PrimarySlot = { report: (owner: string, rect: SlotRect, title: string) => void };

export const PrimarySlotContext = createContext<PrimarySlot | null>(null);

export const StepOwner = createContext<string | null>(null);

export type PhoneScreenKind = "blocking" | "openLink" | "sync" | "tips";

export type PhoneSlotReport = { screen: PhoneScreenKind; rect: SlotRect };

export type PhoneSlotApi = { report: (owner: string, slot: PhoneSlotReport) => void };

export const PhoneSlotContext = createContext<PhoneSlotApi | null>(null);

export function KitPrimary({ title, onPress, testID = "onboardingPrimary" }: { title: string; onPress: () => void; testID?: string }) {
  const slot = useContext(PrimarySlotContext);
  const owner = useContext(StepOwner);
  const frame = useRef<ViewInstance>(null);
  if (!slot) return <ActionButton testID={testID} title={title} onPress={onPress} variant="filled" size="hero" capsule ink={KIT_INK.primary} />;
  const measure = () => {
    if (owner) frame.current?.measureInWindow((x, y, width, height) => slot.report(owner, { x, y, width, height }, title));
  };
  return (
    <View ref={frame} collapsable={false} onLayout={measure}>
      <ActionButton testID={testID} title={title} onPress={onPress} variant="filled" size="hero" capsule ink={KIT_INK.carriedLabel} />
    </View>
  );
}

export function KitSecondary({ title, onPress }: { title: string; onPress: () => void }) {
  return <ActionButton title={title} onPress={onPress} variant="plain" size="regular" ink={KIT_INK.secondary} />;
}

export function KitSubtitle({ text, testID = "onboardingSubtitle" }: { text: string; testID?: string }) {
  return <CrossfadeText testID={testID} text={text} style={[font.body, styles.subtitle]} />;
}

export function KitSettingRow({ label, value, onChange, testID }: { label: string; value: boolean; onChange: (on: boolean) => void; testID?: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: value }} onPress={() => onChange(!value)} style={styles.row}>
      <Text style={[font.body, styles.rowLabel]} numberOfLines={2} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {label}
      </Text>
      <Toggle value={value} onChange={onChange} label={label} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  subtitle: { textAlign: "center", color: brand.creamMuted, ...textHalo },
  row: {
    minHeight: 56,
    borderRadius: 28,
    ...smoothCorners,
    backgroundColor: brand.glass,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: brand.glassEdge,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: space.xl,
    paddingRight: space.m,
    gap: space.m,
  },
  rowLabel: { flex: 1, color: brand.cream },
});
