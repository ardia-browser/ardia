import { forwardRef } from "react";
import { View } from "react-native";
import type { EdgeFadeMaskProps } from "@ardia/shell";

export const EdgeFadeMask = forwardRef<View, EdgeFadeMaskProps>(function EdgeFadeMask({ fadeWidth: _fadeWidth, floor: _floor, onset: _onset, ...props }, ref) {
  return <View {...props} ref={ref} />;
});
