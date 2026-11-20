import { Image, type ImageProps, type ImageStyle, type StyleProp } from "react-native";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";

type TintedImageProps = Omit<ImageProps, "style"> & { tint: string | undefined; style?: StyleProp<ImageStyle>; identity?: string };

export function tintedImageKey(tint: string | undefined, identity = "") {
  return `${identity}\u0000${tint ?? "untinted"}`;
}

export function tintedImage({ tint, style, identity, ...props }: TintedImageProps) {
  return <Image {...props} key={PLATFORM_FEATURES.tintNeedsNewImage ? tintedImageKey(tint, identity) : identity} style={[style, tint ? { tintColor: tint } : null]} />;
}
