import { forwardRef, useEffect, useRef, useState } from "react";
import type { FolderIconProps } from "@ardia/shell";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { animationEffectsOff } from "../animation/reduceMotion";
import { Symbol } from "../symbol/Symbol";
import { folderSwapMs, folderSymbolFor } from "./folderSymbol";
import { colorOrUndefined } from "./shared";

const level = (open: boolean) => (open ? 1 : 0);

export const FolderIcon = forwardRef<unknown, FolderIconProps>(function FolderIcon({ open, stroke, face: _face, insideTop: _insideTop, insideBottom: _insideBottom, style, ...rest }, ref) {
  const wantsOpen = open === true;
  const flat = StyleSheet.flatten(style);
  const closed = folderSymbolFor(false, flat?.width);
  const opened = folderSymbolFor(true, flat?.width);
  const box = { position: "absolute" as const, left: 0, top: 0, width: flat?.width, height: flat?.height };
  const [progress] = useState(() => new Animated.Value(level(wantsOpen)));
  const [closedOpacity] = useState(() => progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }));
  const shown = useRef(wantsOpen);
  const color = colorOrUndefined(stroke);

  useEffect(() => void animationEffectsOff(), []);

  useEffect(() => {
    if (shown.current === wantsOpen) return;
    shown.current = wantsOpen;
    const to = level(wantsOpen);
    progress.stopAnimation((from) => {
      const ms = folderSwapMs(from, to, animationEffectsOff());
      console.info(`[ardia windows] folder icon ${wantsOpen ? "opens" : "closes"} over ${ms} ms at ${Date.now()}`);
      if (ms <= 0) return progress.setValue(to);
      Animated.timing(progress, { toValue: to, duration: ms, easing: Easing.linear, useNativeDriver: true }).start();
    });
  }, [wantsOpen, progress]);

  return (
    <View {...rest} ref={ref as never} pointerEvents="none" style={style}>
      <Animated.View pointerEvents="none" style={[box, { opacity: closedOpacity }]}>
        <Symbol name={closed.name} size={closed.size} weight="medium" color={color} style={box} />
      </Animated.View>
      <Animated.View pointerEvents="none" style={[box, { opacity: progress }]}>
        <Symbol name={opened.name} size={opened.size} weight="medium" color={color} style={box} />
      </Animated.View>
    </View>
  );
});
