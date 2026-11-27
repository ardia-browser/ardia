import type { ScrollViewProps } from "react-native";

export type SidebarScroller = Required<Pick<ScrollViewProps, "showsVerticalScrollIndicator" | "hasOverlayStyleIndicator">>;

export const SIDEBAR_SCROLLER: SidebarScroller = { showsVerticalScrollIndicator: true, hasOverlayStyleIndicator: true };
