import { memo } from "react";
import { SvgIcon as NativeSvgIcon, type SvgIconProps } from "@ardia/shell";
import { hex, useScopedTheme } from "./theme";

export type { SvgIconProps };

export const SvgIcon = memo(function SvgIcon(props: SvgIconProps) {
  useScopedTheme();
  return <NativeSvgIcon {...props} color={props.color && hex(props.color)} />;
});
