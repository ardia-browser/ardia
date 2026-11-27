import { useMemo, type RefObject } from "react";
import { Platform, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView, type ScrollViewProps } from "react-native";
import { noteSidebarScrollerDragged } from "../../state/telemetry/sidebarScrollCounts";

type ScrollerDrag = NativeSyntheticEvent<NativeScrollEvent & { scroller?: boolean }>;

const NO_SCROLLER: ScrollViewProps = { showsVerticalScrollIndicator: false };

export function useSidebarScroller(scroll: RefObject<ScrollView | null>, trailingInset = 0): ScrollViewProps {
  return useMemo(
    () =>
      Platform.OS === "macos"
        ? {
            showsVerticalScrollIndicator: true,
            hasOverlayStyleIndicator: true,
            scrollIndicatorInsets: { top: 0, left: 0, bottom: 0, right: trailingInset },
            onMouseEnter: () => scroll.current?.flashScrollIndicators(),
            onScrollBeginDrag: (e: ScrollerDrag) => {
              if (e.nativeEvent.scroller) noteSidebarScrollerDragged();
            },
          }
        : NO_SCROLLER,
    [scroll, trailingInset],
  );
}
