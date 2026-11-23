import { forwardRef, useImperativeHandle, useRef, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useInputRegion } from "./shellAbove";

type RegionProps = { testID: string; dataSet?: Record<string, string>; capturing?: boolean; children: ReactNode };

export const PageOverlayRegion = forwardRef<View & HTMLElement, RegionProps>(function PageOverlayRegion({ testID, dataSet, capturing = true, children }, ref) {
  const region = useRef<View & Element>(null);
  useImperativeHandle(ref, () => region.current as View & HTMLElement);
  useInputRegion(region, "hit", true, capturing);
  return (
    <View ref={region} testID={testID} pointerEvents="box-none" style={StyleSheet.absoluteFill} {...({ dataSet } as object)}>
      {children}
    </View>
  );
});
