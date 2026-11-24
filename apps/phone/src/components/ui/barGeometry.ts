import { Platform } from "react-native";
import { deckBarCenterFromBottom, floatingBarCenter } from "../../lib/deckGeometry";
import type { Design } from "../../lib/design";
import { currentDesign } from "./design";
import { browseLayout } from "./tokens";
import { materialSize } from "./materialTokens";

export const pageBarCenterFromBottom = (navigationInset: number, os: string) =>
  os === "android" ? Math.max(browseLayout.barCenterFromBottom, navigationInset + browseLayout.hitTarget / 2) : browseLayout.barCenterFromBottom;

export const floatingBarCenterFromBottom = (navigationInset = 0, os: string = Platform.OS) => floatingBarCenter(navigationInset, os);

export const barCenterFromBottom = (navigationInset: number, design: Design = currentDesign()) =>
  design === "material" ? navigationInset + materialSize.bottomBar / 2 : design === "redesigned" ? floatingBarCenterFromBottom(navigationInset) : pageBarCenterFromBottom(navigationInset, Platform.OS);

export const barHeight = (navigationInset: number, design: Design = currentDesign()) =>
  design === "material"
    ? navigationInset + materialSize.bottomBar
    : design === "redesigned" ? browseLayout.barHeight + floatingBarCenterFromBottom(navigationInset) - floatingBarCenterFromBottom() : browseLayout.barHeight + (barCenterFromBottom(navigationInset, design) - browseLayout.barCenterFromBottom);

export const deckCenterFromBottom = (navigationInset: number) => deckBarCenterFromBottom(navigationInset, Platform.OS);
