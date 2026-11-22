import Svg, { Path } from "react-native-svg";
import artwork from "../../../assets/material-symbols.json";
import type { SymbolName } from "./symbolPaths";

type DrawnByArdia = "eyes" | "eyesClosed" | "sparkleMagnifyingglass";

export type MaterialSymbolName = Exclude<SymbolName, DrawnByArdia>;

const names = artwork.javascript satisfies Record<MaterialSymbolName, string>;
const icons: Record<string, { viewBox: string; paths: string[] }> = artwork.icons;

export const materialSymbolFor = (name: SymbolName): MaterialSymbolName | null => (name in names ? (name as MaterialSymbolName) : null);

export const materialSymbolIcon = (name: MaterialSymbolName) => icons[names[name]]!;

export function MaterialSymbol({ name, size, color }: { name: MaterialSymbolName; size: number; color: string }) {
  const icon = materialSymbolIcon(name);
  return (
    <Svg width={size} height={size} viewBox={icon.viewBox}>
      {icon.paths.map((d, index) => <Path key={index} d={d} fill={color} />)}
    </Svg>
  );
}
