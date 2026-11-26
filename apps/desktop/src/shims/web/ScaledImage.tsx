import { forwardRef, type ComponentProps } from "react";
import { Image as WebImage, StyleSheet, View } from "react-native-web";
import { tiledBackground } from "./scaledTile";

type ImageProps = ComponentProps<typeof WebImage>;
type TileStyle = { resizeMode?: unknown; tintColor?: unknown; [key: string]: unknown };

const TILE_BOX = { flexBasis: "auto", overflow: "hidden", zIndex: 0 } as const;

const ScaledImageView = forwardRef<View, ImageProps>(function ScaledImage(props, ref) {
  const { source, style, resizeMode, tintColor, ...rest } = props;
  const { resizeMode: styleMode, tintColor: styleTint, ...box } = (StyleSheet.flatten(style) ?? {}) as TileStyle;
  const tile = tiledBackground(source, resizeMode ?? styleMode, tintColor ?? styleTint);
  if (!tile) return <WebImage ref={ref as never} {...props} />;
  return <View {...(rest as ComponentProps<typeof View>)} ref={ref} role={props.accessibilityLabel ? "img" : undefined} style={[TILE_BOX, box as never, tile as never]} />;
});

export const ScaledImage = Object.assign(ScaledImageView, {
  getSize: WebImage.getSize,
  prefetch: WebImage.prefetch,
  queryCache: WebImage.queryCache,
});
