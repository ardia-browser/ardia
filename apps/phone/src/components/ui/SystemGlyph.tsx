import { Platform } from "react-native";
import { nativeSymbolsAvailable } from "@ardia/phone-native";
import { NativeGlyph, Symbol } from "./Symbol";
import type { SymbolName } from "./symbolPaths";

export type SystemGlyphWeight = "regular" | "medium" | "semibold" | "bold";

type Props = {
  systemName: string;
  pointSize: number;
  weight?: SystemGlyphWeight;
  name: SymbolName;
  size: number;
  color: string;
  fitted?: boolean;
  testID?: string;
};

export const systemGlyphsAvailable = () => Platform.OS === "ios" && nativeSymbolsAvailable();

export function SystemGlyph({ systemName, pointSize, weight = "regular", name, size, color, fitted = false, testID }: Props) {
  if (!systemGlyphsAvailable()) return <Symbol name={name} size={size} color={color} />;
  const side = fitted ? pointSize : size;
  return <NativeGlyph testID={testID} systemName={systemName} pointSize={pointSize} weight={weight} color={color} style={{ width: side, height: side }} />;
}
