import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { WindowBackdrop } from "./rootBackdropUi";
import { spaceLookSource } from "../../browser/src/lib/profileLook";
import { PageThemeContext, profileTheme } from "../../browser/src/components/ui/theme";
import { useProfileLooks } from "../../browser/src/state/profiles/hooks";
import { useWindowId } from "../../browser/src/state/browser/hooks";
import { usePagerPages } from "../../browser/src/state/windows/profilePager";
import { useBrowser } from "../../browser/src/state/browser/store";
import { behindWindowGlassAvailable } from "@platform/windowGlass";
import { scrollTimelineConstructor, seededPosition, supportsScrollTimeline, tintFallbackOpacity, tintKeyframes, tintOpacity, trackSpan, watchPagerTrack, type TintBlend } from "./pagerTrack";

export const PAGER_POSITION_VARIABLE = "--ardia-pager-position";

export const ISOLATED = { isolation: "isolate" } as const;
export const ADDITIVE = { mixBlendMode: "plus-lighter" } as const;

function TintLayer({ windowId, slot, crossfade, last, children }: { windowId: string; slot: number; crossfade: boolean; last: number; children: ReactNode }) {
  const layer = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const element = layer.current;
    if (!element) return;
    const blend: TintBlend = { crossfade, last };
    if (last <= 0 || (!crossfade && slot <= 0)) {
      element.style.opacity = "1";
      return;
    }
    element.style.opacity = String(tintOpacity(selectedSlot(windowId), slot, blend));
    let animation: Animation | null = null;
    const stop = watchPagerTrack(windowId, (track) => {
      animation?.cancel();
      animation = null;
      const Timeline = scrollTimelineConstructor();
      if (!track || !supportsScrollTimeline(track, element, Timeline)) {
        element.style.opacity = tintFallbackOpacity(slot, PAGER_POSITION_VARIABLE, blend);
        return;
      }
      element.style.opacity = "";
      animation = element.animate(tintKeyframes(slot, track.span, blend), { timeline: new Timeline({ source: track.scroller, axis: "x" }), fill: "both", easing: "linear" });
    });
    return () => {
      stop();
      animation?.cancel();
    };
  }, [windowId, slot, crossfade, last]);
  return (
    <View ref={(view) => void (layer.current = view as unknown as HTMLElement | null)} pointerEvents="none" style={[StyleSheet.absoluteFill, { willChange: "opacity" } as object, crossfade ? (ADDITIVE as object) : null]}>
      {children}
    </View>
  );
}

type ReadableValue = { __getValue?: () => number };

function selectedSlot(windowId: string) {
  const s = useBrowser.getState();
  const w = s.windows[windowId];
  return Math.max(0, w ? s.profileOrder.indexOf(w.profileId) : 0);
}

function usePositionVariable(windowId: string, host: React.RefObject<HTMLElement | null>, paging: boolean) {
  const { pager } = usePagerPages(windowId);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element || !paging) return;
    const write = (value: number) => element.style.setProperty(PAGER_POSITION_VARIABLE, String(value));
    let listener: string | null = null;
    const stop = watchPagerTrack(windowId, (track) => {
      const follow = !supportsScrollTimeline(track, element);
      if (follow && listener === null) {
        const value = pager.pos as unknown as ReadableValue;
        write(seededPosition(value.__getValue?.bind(value), selectedSlot(windowId)));
        listener = pager.pos.addListener(({ value }) => write(value));
      } else if (!follow && listener !== null) {
        pager.pos.removeListener(listener);
        listener = null;
      }
    });
    return () => {
      stop();
      if (listener !== null) pager.pos.removeListener(listener);
    };
  }, [pager, windowId, host, paging]);
}

export function ProfileTint() {
  const windowId = useWindowId();
  const { pages, paging } = usePagerPages(windowId);
  const host = useRef<HTMLElement | null>(null);
  usePositionVariable(windowId, host, paging);
  const themes = useProfileLooks(pages, (profile, appDark, settings, palette) => profileTheme(profile, appDark, spaceLookSource(settings), palette, settings.adaptTextToColor));
  const [crossfade] = useState(behindWindowGlassAvailable);
  const last = trackSpan(pages) - 1;
  if (!paging) return null;
  return (
    <View ref={(view) => void (host.current = view as unknown as HTMLElement | null)} pointerEvents="none" style={[StyleSheet.absoluteFill, crossfade ? (ISOLATED as object) : null]}>
      {pages.map((page, k) => {
        const theme = themes[k]!;
        return (
          <TintLayer key={page.id} windowId={windowId} slot={page.slot} crossfade={crossfade} last={last}>
            <PageThemeContext.Provider value={theme}>
              <WindowBackdrop vibrancy {...theme.backdrop} colors={theme.windowTint} grainOpacity={theme.grain} style={StyleSheet.absoluteFill} />
            </PageThemeContext.Provider>
          </TintLayer>
        );
      })}
    </View>
  );
}
