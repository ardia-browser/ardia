import { Image, type ImageProps, type ImageStyle, type StyleProp } from "react-native";

type TintedImageProps = Omit<ImageProps, "style"> & { tint: string | undefined; style?: StyleProp<ImageStyle>; identity?: string };

export function tintedImageKey(tint: string | undefined, identity = "") {
  return `${identity}\u0000${tint ?? "untinted"}`;
}

export function TintedImage({ tint, style, identity, ...props }: TintedImageProps) {
  return <Image {...props} key={tintedImageKey(tint, identity)} style={[style, tint ? { tintColor: tint } : null]} />;
}
