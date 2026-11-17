import { Platform } from "react-native";
import { BUTTON_NAVIGATION_INSET, deckBarCenterFromBottom } from "../../lib/deckGeometry";
import type { Design } from "../../lib/design";
import { appDesign } from "./design";
import { browseLayout, floatingBarLayout } from "./tokens";

export const pageBarCenterFromBottom = (navigationInset: number, os: string) =>
  os === "android" ? Math.max(browseLayout.barCenterFromBottom, navigationInset + browseLayout.hitTarget / 2) : browseLayout.barCenterFromBottom;

export const floatingBarCenterFromBottom = (navigationInset = 0, os: string = Platform.OS) => {
  const iPhonePlacement = floatingBarLayout.bottomGap + floatingBarLayout.control / 2;
  if (os === "android" && navigationInset > BUTTON_NAVIGATION_INSET) return Math.max(iPhonePlacement, navigationInset + floatingBarLayout.gap + floatingBarLayout.control / 2);
  return iPhonePlacement;
};

export const barCenterFromBottom = (navigationInset: number, design: Design = appDesign) =>
  design === "redesigned" ? floatingBarCenterFromBottom(navigationInset) : pageBarCenterFromBottom(navigationInset, Platform.OS);

export const barHeight = (navigationInset: number, design: Design = appDesign) =>
  design === "redesigned" ? browseLayout.barHeight + floatingBarCenterFromBottom(navigationInset) - floatingBarCenterFromBottom() : browseLayout.barHeight + (barCenterFromBottom(navigationInset, design) - browseLayout.barCenterFromBottom);

export const deckCenterFromBottom = (navigationInset: number) => deckBarCenterFromBottom(navigationInset, Platform.OS);
