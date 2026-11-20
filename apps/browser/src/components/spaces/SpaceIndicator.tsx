import { useRef } from "react";
import { Animated, Pressable, View } from "react-native";
import { spaceNameColor, useTheme } from "../ui/theme";
import { useIsIncognito, useSpaces, useWindowId, useWindowSpace } from "../../state/browser/hooks";
import { setMeasuredWidth, useMeasuredWidth } from "../../state/windows/measuredWidths";
import { ContextMenuArea, radius, Symbol, Text, useHover } from "../ui";
import { openSpaceItemMenu } from "./spaceMenu";
import { openSpaceMenu } from "../../state/browser/actions";
import { WINDOW_CHROME } from "../../lib/windowChrome";
import { CARD_INSET } from "../../lib/windowLayout";
import { buttonMotion, usePressScaleMotion } from "../ui/motion";

const PAD = 9;
const HEIGHT = 34;
const MIN_CUT_NAME = 52;
const ICON_WIDTH = 32;
export const PROFILE_INDICATOR_X = Math.max(WINDOW_CHROME.leadingWidth + 6, CARD_INSET);

function useIndicator(room: number) {
  const theme = useTheme();
  const incognito = useIsIncognito();
  const spaces = useSpaces();
  const space = useWindowSpace();
  const title = incognito ? "Incognito" : space.name;
  const textWidth = useMeasuredWidth(`space-name|${title}`);
  const shown = (incognito || spaces.length >= 2) && room >= ICON_WIDTH;
  const nameRoom = room - 2 * PAD;
  const showName = !!textWidth && (textWidth <= nameRoom || nameRoom >= MIN_CUT_NAME);
  const width = !shown ? 0 : showName ? Math.min(room, textWidth + 2 * PAD) : ICON_WIDTH;
  const color = incognito ? theme.textPrimary : spaceNameColor(space, theme.dark);
  return { incognito, title, textWidth, shown, showName, width, color, profileId: space.id };
}

export const useSpaceIndicatorWidth = (room: number) => useIndicator(room).width;

export function SpaceIndicator({ room }: { room: number }) {
  const theme = useTheme();
  const windowId = useWindowId();
  const { hovered, hoverProps } = useHover();
  const { incognito, title, textWidth, shown, showName, width, color, profileId } = useIndicator(room);
  const pressMotion = usePressScaleMotion(!incognito && !showName && !!textWidth, buttonMotion.iconPressScale);
  const indicator = useRef<View>(null);
  if (!shown) return null;

  return (
    <View {...hoverProps} ref={indicator} tooltip={incognito ? undefined : "Switch between spaces"}>
      <View pointerEvents="none" style={{ position: "absolute", width: 1000, height: 0, overflow: "hidden", opacity: 0 }}>
        <Text
          numberOfLines={1}
          weight="semibold"
          style={{ alignSelf: "flex-start" }}
          onLayout={(e) => setMeasuredWidth(`space-name|${title}`, Math.ceil(e.nativeEvent.layout.width))}
        >
          {title}
        </Text>
      </View>
      <ContextMenuArea onContextMenu={() => !incognito && void openSpaceItemMenu(profileId, "sidebar", windowId, indicator.current)}>
        <Pressable
          onPress={() => !incognito && void openSpaceMenu(windowId)}
          onPressIn={pressMotion.onPressIn}
          onPressOut={pressMotion.onPressOut}
          disabled={incognito}
        >
          {({ pressed }) => (
            <View
              style={{
                height: HEIGHT,
                width,
                borderRadius: radius.chrome,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                paddingHorizontal: showName ? PAD : 0,
                backgroundColor: incognito ? undefined : pressed ? theme.tabPressed : hovered ? theme.tabHover : undefined,
              }}
            >
              {showName ? (
                <Text numberOfLines={1} ellipsizeMode="tail" weight="semibold" style={{ flexShrink: 1, color }}>
                  {title}
                </Text>
              ) : textWidth ? (
                <Animated.View style={[PROFILE_GLYPH, pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : null]}>
                  <Symbol name="person.fill" size={14} weight="semibold" color={color} style={PROFILE_GLYPH} />
                </Animated.View>
              ) : null}
            </View>
          )}
        </Pressable>
      </ContextMenuArea>
    </View>
  );
}

const PROFILE_GLYPH = { width: 16, height: 16, alignItems: "center", justifyContent: "center" } as const;
