import { pageObscuresInsets } from "@ardia/phone-native";
import { createContext, useContext, type ReactNode } from "react";
import { Platform } from "react-native";
import { designFor, type Design } from "../../lib/design";
import { isLabBuild } from "../../platform/lab";
import { launchArguments } from "../../state/app/launchFlags";

export const appDesign: Design = designFor(Platform.OS, isLabBuild && launchArguments().redesign);

const DesignContext = createContext<Design>(appDesign);

export const useDesign = () => useContext(DesignContext);

export const usePageUnderBars = () => useDesign() === "redesigned" && pageObscuresInsets();

export function DesignProvider({ design, children }: { design: Design; children: ReactNode }) {
  return <DesignContext.Provider value={design}>{children}</DesignContext.Provider>;
}
