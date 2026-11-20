import { View } from "react-native";
import { edgeFadeView, type EdgeFadeProps } from "@ardia/shell";

export function EdgeFade(props: EdgeFadeProps) {
  const Fade = edgeFadeView();
  return Fade ? <Fade {...props} /> : <View style={props.style}>{props.children}</View>;
}
