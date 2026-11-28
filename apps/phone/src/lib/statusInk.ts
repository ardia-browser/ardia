import { luminance, mixColors } from "./color.ts";
import { compositeOver } from "./readableInk.ts";

export type InkLayer = "cover" | "voice" | "sheet" | "search" | "deck" | "page";

export type InkScene = { onboarding: boolean; voice: boolean; sheet: boolean; searching: boolean; surface: "start" | "deck" | "browsing" };

export function inkLayer(scene: InkScene): InkLayer {
  if (scene.onboarding) return "cover";
  if (scene.voice) return "voice";
  if (scene.sheet) return "sheet";
  if (scene.searching || scene.surface === "start") return "search";
  if (scene.surface === "deck") return "deck";
  return "page";
}

const SCRIM_ALPHA = 0.25;
const CONTRAST_MIDPOINT = 0.179;

const isLight = (color: string) => luminance(color) > CONTRAST_MIDPOINT;

export type InkColors = { cover: string; under: string; deck: string; searchDim: string | null; incognito: boolean };

export function lightStatusIcons(layer: InkLayer, colors: InkColors): boolean | null {
  switch (layer) {
    case "page":
      return null;
    case "voice":
      return true;
    case "cover":
      return !isLight(colors.cover);
    case "sheet":
      return !isLight(mixColors(colors.under, "#000000", SCRIM_ALPHA));
    case "search":
      return colors.incognito || !isLight(colors.searchDim ? compositeOver(colors.searchDim, colors.under) : colors.under);
    case "deck":
      return !isLight(colors.deck);
  }
}

export type UnderStatus = { surface: InkScene["surface"]; pageTop: string | null; blankPage: string; start: string; deck: string };

export const underStatusBar = ({ surface, pageTop, blankPage, start, deck }: UnderStatus) => (surface === "browsing" ? (pageTop ?? blankPage) : surface === "deck" ? deck : start);
