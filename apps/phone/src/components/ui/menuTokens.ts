import { Platform } from "react-native";
import { colorRoles, menuInk, menuLook, shape } from "./tokens";
import { t } from "../../lib/uiLanguage";


const DRAWN_MENU_PRESS_INSET = 6;

const iPhoneDrawnMenuLook: typeof menuLook = {
  ...menuLook,
  radius: shape.card,
  labelInset: 18,
  labelInsetChecked: 40,
  labelInsetIcon: 52,
  trailingInset: 18,
  iconCentre: 30,
  iconSlot: 24,
  iconSize: 18,
  checkLeft: 18,
  checkSize: 12,
  pressInset: DRAWN_MENU_PRESS_INSET,
  pressRadius: shape.card - DRAWN_MENU_PRESS_INSET,
  dividerInset: 0,
  dividerLine: 1,
  label: { fontSize: 17, lineHeight: 22 },
  shadow: t(`0px 8px 32px rgba(0,0,0,0.18)`),
};

const iPhoneDrawnMenuInk: typeof menuInk = {
  light: {
    fill: "rgba(255,255,255,0.94)",
    solid: "#FFFFFF",
    label: "#000000",
    icon: "#000000",
    destructive: colorRoles.light.destructive,
    highlight: "rgba(0,0,0,0.07)",
    divider: "rgba(60,60,67,0.12)",
    rim: "rgba(0,0,0,0.08)",
    specular: "rgba(255,255,255,0.7)",
    heading: "rgba(60,60,67,0.6)",
    dim: "rgba(0,0,0,0.2)",
  },
  dark: {
    fill: "rgba(44,44,46,0.94)",
    solid: "#2C2C2E",
    label: "#FFFFFF",
    icon: "#FFFFFF",
    destructive: colorRoles.dark.destructive,
    highlight: "rgba(255,255,255,0.1)",
    divider: "rgba(255,255,255,0.1)",
    rim: "rgba(255,255,255,0.1)",
    specular: "rgba(255,255,255,0.08)",
    heading: "rgba(235,235,245,0.6)",
    dim: "rgba(0,0,0,0.48)",
  },
};

export const drawnMenuLook = Platform.OS === "android" ? menuLook : iPhoneDrawnMenuLook;

export const drawnMenuInk = Platform.OS === "android" ? menuInk : iPhoneDrawnMenuInk;
