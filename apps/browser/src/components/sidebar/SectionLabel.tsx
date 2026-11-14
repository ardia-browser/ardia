import { Text } from "../ui";
import { sidebarLineHeight } from "../ui/tokens";

export function SectionLabel({ title, inset, top = 0, bottom = 0 }: { title: string; inset: number; top?: number; bottom?: number }) {
  return (
    <Text lines={1} size="caption" weight="semibold" tone="textSecondary" style={{ lineHeight: sidebarLineHeight.caption, paddingHorizontal: inset, paddingTop: top, paddingBottom: bottom }}>
      {title}
    </Text>
  );
}
