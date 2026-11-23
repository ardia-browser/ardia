import { processColor, type ViewProps } from "react-native";
import * as NativeComponentRegistry from "react-native/Libraries/NativeComponent/NativeComponentRegistry";
import type { VectorLayer } from "./layers";

export type NativeVectorIconProps = ViewProps & { symbolKey: string; layers: VectorLayer[]; color?: string };

export const NativeVectorIcon = NativeComponentRegistry.get<NativeVectorIconProps>("ArdiaVectorIcon", () => ({
  uiViewClassName: "ArdiaVectorIcon",
  validAttributes: {
    symbolKey: true,
    layers: true,
    color: { process: processColor as (value: never) => unknown },
  },
}));
