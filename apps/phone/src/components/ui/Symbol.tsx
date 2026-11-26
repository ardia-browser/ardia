import { Platform, processColor, type ColorValue, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Path } from "react-native-svg";
import { NativeSymbol, nativeSymbolsAvailable, type NativeSymbolWeight } from "@ardia/phone-native";
import { useDesign } from "./design";
import { materialSymbolFor, materialSymbolIcon } from "./MaterialSymbol";
import { SF_SYMBOL_NAMES, sfPointSizePerSide } from "./sfSymbolNames";
import { SYMBOLS, type SymbolName } from "./symbolPaths";

export type SymbolWeight = NativeSymbolWeight;

export const nativeSymbolColor = (color: ColorValue) => (processColor(color) ?? undefined) as unknown as string | undefined;

type NativeGlyphProps = { systemName: string; pointSize: number; weight: SymbolWeight; color: ColorValue; style: StyleProp<ViewStyle>; testID?: string };

export function NativeGlyph({ systemName, pointSize, weight, color, style, testID }: NativeGlyphProps) {
  return <NativeSymbol testID={testID} pointerEvents="none" name={systemName} pointSize={pointSize} weight={weight} color={nativeSymbolColor(color)} style={style} />;
}

export const nativeSymbolFor = (name: SymbolName) => (Platform.OS === "ios" && nativeSymbolsAvailable() ? SF_SYMBOL_NAMES[name] : null);

export function Symbol({ name, size, color, weight = "regular" }: { name: SymbolName; size: number; color: string; weight?: SymbolWeight }) {
  const design = useDesign();
  const drawn = Platform.OS === "android" ? materialSymbolFor(name) : null;
  const systemName = design === "material" ? null : nativeSymbolFor(name);
  if (systemName) return <NativeGlyph systemName={systemName} pointSize={size * sfPointSizePerSide(name)} weight={weight} color={color} style={{ width: size, height: size }} />;
  const icon = drawn ? materialSymbolIcon(drawn) : null;
  return (
    <Svg width={size} height={size} viewBox={icon ? icon.viewBox : "0 0 24 24"}>
      {icon
        ? icon.paths.map((d, index) => <Path key={index} d={d} fill={color} />)
        : SYMBOLS[name].map((layer, index) => (
            <Path
              key={index}
              d={layer.d}
              fill={"fill" in layer && layer.fill ? color : "none"}
              fillRule={"evenOdd" in layer && layer.evenOdd ? "evenodd" : "nonzero"}
              stroke={"stroke" in layer ? color : "none"}
              strokeWidth={"stroke" in layer ? layer.stroke : 0}
              strokeLinecap="round"
              strokeLinejoin="round"
              rotation={"rotate" in layer ? layer.rotate : 0}
              scale={"scale" in layer ? layer.scale : 1}
              translate={"shift" in layer ? [layer.shift ?? 0, layer.shift ?? 0] : undefined}
              origin="12, 12"
            />
          ))}
    </Svg>
  );
}
