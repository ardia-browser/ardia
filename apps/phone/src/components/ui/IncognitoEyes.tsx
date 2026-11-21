import { Platform } from "react-native";
import Svg, { Path } from "react-native-svg";
import { isDarkColor } from "../../lib/color";

const SIDE = 24;
const EYE = { rx: 4.2, ry: 6.2, gap: 1.6, lookAt: 14, lookReach: 3.2, lookOuter: 4.6, lookInner: 2.7 };
const OUTLINE = 1.4;
const PUPIL = { r: 2.5, dx: -1.4, dy: 0.6 };
const SHINE = { r: 0.6, dx: -0.8, dy: -0.9 };
const EYE_CENTERS = [SIDE / 2 - EYE.gap / 2 - EYE.rx, SIDE / 2 + EYE.gap / 2 + EYE.rx];
const WATCHING_ON_ANDROID = Platform.OS === "android";
const SCLERA = "#FFFFFF";
const PUPIL_INK = "#1C1D22";

const ellipse = (cx: number, cy: number, rx: number, ry: number) => `M${cx - rx} ${cy}A${rx} ${ry} 0 1 1 ${cx + rx} ${cy}A${rx} ${ry} 0 1 1 ${cx - rx} ${cy}Z`;

const oval = (cx: number) => ellipse(cx, SIDE / 2, EYE.rx, EYE.ry);

const lookingDown = (cx: number) => {
  const from = cx - EYE.lookReach;
  const to = cx + EYE.lookReach;
  return `M${from} ${EYE.lookAt}Q${cx} ${EYE.lookAt + EYE.lookOuter} ${to} ${EYE.lookAt}Q${cx} ${EYE.lookAt + EYE.lookInner} ${from} ${EYE.lookAt}Z`;
};

export const incognitoEyesPath = (incognito: boolean) => EYE_CENTERS.map((cx) => oval(cx) + (incognito ? lookingDown(cx) : "")).join("");

export const incognitoEyesLidded = () => incognitoEyesPath(true);

export const incognitoEyeOutlines = () => EYE_CENTERS.map((cx) => ellipse(cx, SIDE / 2, EYE.rx - OUTLINE / 2, EYE.ry - OUTLINE / 2)).join("");

export const incognitoEyeWhites = () => EYE_CENTERS.map(oval).join("");

export const incognitoPupils = () => EYE_CENTERS.map((cx) => ellipse(cx + PUPIL.dx, SIDE / 2 + PUPIL.dy, PUPIL.r, PUPIL.r)).join("");

export const incognitoShines = () => EYE_CENTERS.map((cx) => ellipse(cx + PUPIL.dx + SHINE.dx, SIDE / 2 + PUPIL.dy + SHINE.dy, SHINE.r, SHINE.r)).join("");

export function IncognitoEyes({ size, color, incognito = false, testID }: { size: number; color: string; incognito?: boolean; testID?: string }) {
  const box = { testID, width: size, height: size, viewBox: `0 0 ${SIDE} ${SIDE}` };
  if (!WATCHING_ON_ANDROID) {
    return (
      <Svg {...box}>
        <Path d={incognitoEyesPath(incognito)} fill={color} fillRule="evenodd" />
      </Svg>
    );
  }
  if (incognito) {
    return (
      <Svg {...box}>
        <Path d={incognitoEyesLidded()} fill={color} fillRule="evenodd" />
      </Svg>
    );
  }
  const onLight = isDarkColor(color);
  return (
    <Svg {...box}>
      {onLight ? <Path d={incognitoEyeOutlines()} fill={SCLERA} stroke={color} strokeWidth={OUTLINE} /> : <Path d={incognitoEyeWhites()} fill={color} />}
      <Path d={incognitoPupils()} fill={onLight ? color : PUPIL_INK} />
      <Path d={incognitoShines()} fill={onLight ? SCLERA : color} />
    </Svg>
  );
}
