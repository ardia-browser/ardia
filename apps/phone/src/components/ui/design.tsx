import { pageObscuresInsets } from "@ardia/phone-native";
import { createContext, useContext, type ReactNode } from "react";
import { Platform } from "react-native";
import { designFor, type Design } from "../../lib/design";
import { isLabBuild } from "../../platform/lab";
import { launchArguments } from "../../state/app/launchFlags";
import { currentPreferences, usePreferences } from "../../state/settings/store";

const labRedesign = () => isLabBuild && launchArguments().redesign;

export const appDesign: Design = designFor(Platform.OS, labRedesign());

export const designWith = (materialYou: boolean): Design => designFor(Platform.OS, labRedesign(), materialYou);

export const currentDesign = (): Design => designWith(currentPreferences().materialYou);

export const materialYouOffered = () => Platform.OS === "android";

const DesignContext = createContext<Design | null>(null);

export function useDesign(): Design {
  const pinned = useContext(DesignContext);
  const materialYou = usePreferences((p) => p.materialYou);
  return pinned ?? designWith(materialYou);
}

export function followDesign(apply: (design: Design) => void): () => void {
  let applied = currentDesign();
  apply(applied);
  return usePreferences.subscribe(() => {
    const next = currentDesign();
    if (next === applied) return;
    applied = next;
    apply(next);
  });
}

export const usePageUnderBars = () => {
  const design = useDesign();
  return (design === "redesigned" || design === "material") && pageObscuresInsets();
};

export function DesignProvider({ design, children }: { design: Design; children: ReactNode }) {
  return <DesignContext.Provider value={design}>{children}</DesignContext.Provider>;
}
