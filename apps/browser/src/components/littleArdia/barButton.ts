export type SmallBarButton = { icon: string; tooltip: string; shortcut?: string; onPress: () => void; disabled?: boolean };

export const smallBarTooltip = (b: Pick<SmallBarButton, "tooltip" | "shortcut">) => (b.shortcut ? `${b.tooltip} (${b.shortcut})` : b.tooltip);

export const smallBarHint = (b: Pick<SmallBarButton, "shortcut">) => (b.shortcut ? `Shortcut: ${b.shortcut}` : undefined);

export type BarTips = { hovered: number | null; focused: number | null };

export const NO_BAR_TIPS: BarTips = { hovered: null, focused: null };

export function barTipsChanged(tips: BarTips, index: number, via: "hover" | "focus", on: boolean): BarTips {
  const key = via === "hover" ? "hovered" : "focused";
  if (on) return tips[key] === index ? tips : { ...tips, [key]: index };
  return tips[key] === index ? { ...tips, [key]: null } : tips;
}

export const barTipOwner = (tips: BarTips): number | null => tips.hovered ?? tips.focused;
