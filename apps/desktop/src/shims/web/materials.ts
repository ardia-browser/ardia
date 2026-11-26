import { popoverMenuMaterial } from "../../../../browser/src/components/ui/tokens";

export type MaterialFill = { light: string; dark: string };

export const MATERIAL_FILL: Record<string, MaterialFill> = {
  popover: popoverMenuMaterial,
  menu: popoverMenuMaterial,
  hudWindow: { light: "rgba(246,246,246,0.6)", dark: "rgba(30,30,30,0.6)" },
  sidebar: { light: "rgba(240,240,240,0.5)", dark: "rgba(46,46,48,0.5)" },
  underWindowBackground: { light: "rgba(240,240,240,0.4)", dark: "rgba(30,30,30,0.4)" },
};

export const PLAIN_MATERIAL: MaterialFill = { light: "rgba(246,246,246,0.6)", dark: "rgba(40,40,42,0.6)" };

export const materialFill = (material: string, dark: boolean) => (MATERIAL_FILL[material] ?? PLAIN_MATERIAL)[dark ? "dark" : "light"];
