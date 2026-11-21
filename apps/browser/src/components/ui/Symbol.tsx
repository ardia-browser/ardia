import { Symbol as NativeSymbol, type SymbolProps } from "@ardia/shell";
import { iconName } from "../../lib/activeLook";
import { hex, useScopedTheme } from "./theme";

export type { SymbolProps };

export function Symbol(props: SymbolProps) {
  useScopedTheme();
  return <NativeSymbol {...props} name={iconName(props.name)} color={props.color && hex(props.color)} />;
}
