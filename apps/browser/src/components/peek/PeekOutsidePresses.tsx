import type { ReactNode } from "react";
import { View, type GestureResponderEvent, type StyleProp, type ViewStyle } from "react-native";
import { useWindowId } from "../../state/browser/hooks";
import { cancelPeekOutsidePress, endPeekOutsidePress, movePeekOutsidePress, startPeekOutsidePress } from "../../state/peek/outsidePresses";

const pointOf = (press: GestureResponderEvent) => ({ x: press.nativeEvent.pageX, y: press.nativeEvent.pageY });
const buttonOf = (press: GestureResponderEvent) => (press.nativeEvent as { button?: number }).button;

export function PeekOutsidePresses({ style, children }: { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const windowId = useWindowId();
  return (
    <View
      style={style}
      onStartShouldSetResponderCapture={(press) => {
        startPeekOutsidePress(windowId, pointOf(press), buttonOf(press));
        return false;
      }}
      onTouchMove={(press) => movePeekOutsidePress(windowId, pointOf(press))}
      onTouchEnd={(press) => endPeekOutsidePress(windowId, pointOf(press))}
      onTouchCancel={() => cancelPeekOutsidePress(windowId)}
    >
      {children}
    </View>
  );
}
