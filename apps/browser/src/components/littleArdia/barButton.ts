export type SmallBarButton = { icon: string; tooltip: string; shortcut?: string; onPress: () => void; disabled?: boolean };

export const smallBarTooltip = (b: Pick<SmallBarButton, "tooltip" | "shortcut">) => (b.shortcut ? `${b.tooltip} (${b.shortcut})` : b.tooltip);

export const smallBarHint = (b: Pick<SmallBarButton, "shortcut">) => (b.shortcut ? `Shortcut: ${b.shortcut}` : undefined);
