import type { ReactNode } from "react";
import { windowOverlays as browserWindowOverlays } from "../../browser/src/components/window/WindowOverlays";
import { PageOverlayRegion } from "./PageOverlayRegion";

export const windowOverlays = (children: ReactNode) => <PageOverlayRegion testID="ardia-window-overlays">{browserWindowOverlays(children)}</PageOverlayRegion>;
