import { StyleSheet, View } from "react-native";
import { useSettings, useTabLayout } from "../../state/browser/hooks";
import { chooseSidebarSide, toggleTabLayout } from "../../state/settings/actions";
import type { Settings } from "../../state/settings/settings";
import { MiniWindow } from "../settings/MiniWindow";
import { Segmented, Text, type SegmentOption } from "../ui";
import { OptionCard } from "./OptionCard";
import { useOnboardingColors } from "./Parts";
import { radius, space } from "../ui/tokens";
import { t } from "../../lib/uiLanguage";


export const PERSONALIZE_COPY = {
  title: t(`Make it yours`),
  subtitle: t(`Pick the theme color and layout that feel right for you.`),
  layouts: t(`Choose how you would like to view your tabs:`),
  side: t(`Sidebar on the`),
} as const;

type Side = Settings["sidebarSide"];

const SIDE_OPTIONS: SegmentOption<Side>[] = [
  { value: "left", title: t(`Left`) },
  { value: "right", title: t(`Right`) },
];

const OFF_OPACITY = 0.4;

export function TabLayoutPicker({ windowId }: { windowId: string }) {
  const layout = useTabLayout(windowId);
  const side = useSettings((s) => s.sidebarSide);
  const pick = (next: "sidebar" | "top") => {
    if (next !== layout) toggleTabLayout(windowId);
  };
  const sideOn = layout === "sidebar";
  return (
    <View style={{ gap: space.ml }}>
      <View style={{ flexDirection: "row", gap: space.ml }} accessibilityRole="radiogroup" accessibilityLabel={t(`Tab layout`)}>
        <LayoutButton kind="sidebar" side={side} title={t(`Sidebar`)} subtitle={t(`Tabs down the side`)} selected={layout === "sidebar"} onPress={() => pick("sidebar")} />
        <LayoutButton kind="top" side="left" title={t(`Classic`)} subtitle={t(`Tabs along the top`)} selected={layout === "top"} onPress={() => pick("top")} />
      </View>
      <View
        pointerEvents={sideOn ? "auto" : "none"}
        accessibilityState={{ disabled: !sideOn }}
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.xs, opacity: sideOn ? 1 : OFF_OPACITY }}
      >
        <Text size="small" tone="textSecondary">
          {PERSONALIZE_COPY.side}
        </Text>
        <Segmented options={SIDE_OPTIONS} value={side} onChange={chooseSidebarSide} />
      </View>
    </View>
  );
}

const LAYOUT_PREVIEW_HEIGHT = 64;

function LayoutButton({ kind, side, title, subtitle, selected, onPress }: { kind: "sidebar" | "top"; side: Side; title: string; subtitle: string; selected: boolean; onPress: () => void }) {
  const colors = useOnboardingColors();
  const preview = (
    <View style={{ height: LAYOUT_PREVIEW_HEIGHT, borderRadius: radius.tile, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth * 2, borderColor: colors.previewBorder }}>
      <MiniWindow
        layout={kind === "sidebar" ? "side" : "top"}
        side={side}
        bars={[1, 0.8, 0.9]}
        size="m"
        look={{ window: colors.preview, bar: colors.progressTrack, page: colors.card, edge: colors.previewBorder }}
      />
    </View>
  );
  return <OptionCard control="radio" title={title} subtitle={subtitle} selected={selected} onPress={onPress} preview={preview} />;
}
