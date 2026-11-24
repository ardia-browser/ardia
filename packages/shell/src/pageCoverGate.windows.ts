import { requireNativeViewManager } from "expo-modules-core";
import type { PageCoverGateProps } from "./pageCoverGate";

export const PageCoverGate = requireNativeViewManager<PageCoverGateProps>("ArdiaPageCoverGate");
