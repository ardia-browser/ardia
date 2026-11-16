import { memo } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { AwayTitle } from "../../state/pins/organize";
import { FadeLabel } from "../ui";
import { withAlpha } from "../ui/tokens";
import { AWAY_TITLE, SLEEPING_TITLE_OPACITY } from "./tokens";

export const AwayTitleLabel = memo(function AwayTitleLabel({
  away,
  color,
  fontSize,
  weight,
  height,
  struck = false,
  style,
}: {
  away: AwayTitle;
  color: string;
  fontSize: number;
  weight?: "medium" | "regular";
  height: number;
  struck?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const fontWeight = weight === "medium" ? "500" : undefined;
  return (
    <View accessible accessibilityLabel={`${away.pinned ?? "Pinned tab"}, now on ${away.page}`} style={[{ flexDirection: "row", alignItems: "center", height }, style, struck && { opacity: SLEEPING_TITLE_OPACITY }]}>
      {away.pinned ? (
        <Text numberOfLines={1} style={{ fontSize, fontWeight, color, flexShrink: 1, maxWidth: AWAY_TITLE.pinnedMaxWidth, textDecorationLine: struck ? "line-through" : "none" }}>
          {away.pinned}
        </Text>
      ) : null}
      <Text style={{ fontSize, fontWeight, color: withAlpha(color, AWAY_TITLE.slashAlpha), marginLeft: away.pinned ? AWAY_TITLE.slashGap : 0, marginRight: AWAY_TITLE.slashGap }}>/</Text>
      <FadeLabel text={away.page} fontSize={fontSize} weight={weight} color={color} strikethrough={struck} style={{ flex: 1, height }} />
    </View>
  );
});
