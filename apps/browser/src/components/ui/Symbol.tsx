import { memo } from "react";
import { Symbol as NativeSymbol, type SymbolProps } from "@ardia/shell";
import { iconName } from "../../lib/activeLook";
import { hex, useScopedTheme } from "./theme";

export type { SymbolProps };

export const drawnSymbol = (props: SymbolProps) => <NativeSymbol {...props} name={iconName(props.name)} color={props.color && hex(props.color)} />;

export const Symbol = memo(function Symbol(props: SymbolProps) {
  useScopedTheme();
  return drawnSymbol(props);
});
