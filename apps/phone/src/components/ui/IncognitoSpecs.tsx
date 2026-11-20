import Svg, { Path } from "react-native-svg";
import { SYMBOLS } from "./symbolPaths";

const BOX = 24;
const DRAWN_STROKE = SYMBOLS.eyeglassesThin[0]!.stroke ?? 1.1;
const THINNEST_LINE = 1.2;
const BOUNDS = { top: 9.5, bottom: 16.2 };
const RAISE = (BOUNDS.top + BOUNDS.bottom) / 2 - BOX / 2;

export const specsStroke = (size: number) => Math.max(DRAWN_STROKE, (THINNEST_LINE * BOX) / size);

export function IncognitoSpecs({ size, color, testID }: { size: number; color: string; testID?: string }) {
  return (
    <Svg testID={testID} width={size} height={size} viewBox={`0 ${RAISE} ${BOX} ${BOX}`}>
      <Path d={SYMBOLS.eyeglassesThin[0]!.d} fill="none" stroke={color} strokeWidth={specsStroke(size)} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
