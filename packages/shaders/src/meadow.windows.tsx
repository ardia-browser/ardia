import { requireNativeViewManager } from "expo-modules-core";
import { useState, type ComponentType } from "react";
import { Image, StyleSheet, View, type ImageSourcePropType, type LayoutChangeEvent } from "react-native";
import type { MeadowIntroEvent, MeadowProps } from "./index";
import { nearestPoster as nearestOf, posterFrame } from "./meadowPage/posters";
import posters from "../ios/Meadow/posters.json";

type Poster = (typeof posters)[number];
type Size = { width: number; height: number };

const DAWN: Record<string, ImageSourcePropType> = {
  "dawn-wider-2196.webp": require("../windows/meadow/dawn-wider-2196.jpg"),
  "dawn-wide-1766.webp": require("../windows/meadow/dawn-wide-1766.jpg"),
  "dawn-laptop-1917.webp": require("../windows/meadow/dawn-laptop-1917.jpg"),
  "dawn-mid-1600.webp": require("../windows/meadow/dawn-mid-1600.jpg"),
};

export const WINDOWS_POSTERS = posters.filter((p) => p.state === "dawn" && Object.hasOwn(DAWN, p.file));

export const nearestPoster = (aspect: number): Poster | null => nearestOf(WINDOWS_POSTERS, aspect);

export { posterFrame };

let MeadowPage: ComponentType<MeadowProps> | null = null;

export function Meadow({ night, style, testID, intro, onIntro, onTone }: MeadowProps) {
  const [size, setSize] = useState<Size | null>(null);
  const [live, setLive] = useState(false);
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((now) => (now && now.width === width && now.height === height ? now : { width, height }));
  };
  const told = (event: MeadowIntroEvent) => {
    if (event.kind === "live") setLive(true);
    if (event.kind === "fallback") setLive(false);
    onIntro?.(event);
  };
  if (intro) MeadowPage ??= requireNativeViewManager<MeadowProps>("ArdiaMeadowPage");
  const poster = !night && !live && size && size.width > 0 && size.height > 0 ? nearestPoster(size.width / size.height) : null;
  return (
    <View pointerEvents="none" testID={testID} style={[style, { overflow: "hidden" }]} onLayout={onLayout}>
      {poster && size && <Image source={DAWN[poster.file]!} fadeDuration={0} style={{ position: "absolute", ...posterFrame(poster, size) }} />}
      {intro && MeadowPage && <MeadowPage night={night} intro={intro} onIntro={told} onTone={onTone} style={StyleSheet.absoluteFill} />}
    </View>
  );
}
