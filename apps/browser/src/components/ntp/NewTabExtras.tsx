import { useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { useWindow, useWindowId } from "../../state/browser/hooks";
import { tourAnchorRef } from "../onboarding/tour/anchors";
import { CheckInBanner } from "./CheckInBanner";
import { PersonalizeButton } from "./Personalize";
import { ReleaseNotesPage, ReleaseNotesPostcard } from "./Postcard";
import { TelemetryAsk } from "./TelemetryAsk";
import { PeekCoversCards, usePeekClearance } from "./peekClearance";
import { closeReleaseNotes, openReleaseNotes, retireReleaseNotes, usePendingReleaseNotes, useReleaseNotesPage } from "../../state/releaseNotes/releaseNotes";

export type Frame = { x: number; y: number; width: number; height: number };

export function NewTabExtras({ size, bar }: { size: { width: number; height: number }; bar: Frame }) {
  const windowId = useWindowId();
  const incognito = useWindow(windowId, (w) => w?.kind === "private");
  const pending = usePendingReleaseNotes();
  const page = useReleaseNotesPage(windowId);
  const area = useRef<View>(null);
  const clearance = usePeekClearance(windowId, area);

  return (
    <View ref={area} style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <View ref={tourAnchorRef(windowId, "page")} style={StyleSheet.absoluteFill} pointerEvents="none" />
      <View ref={tourAnchorRef(windowId, "commandBar")} style={{ position: "absolute", left: bar.x, top: bar.y, width: bar.width, height: bar.height }} pointerEvents="none" />
      <Animated.View style={[StyleSheet.absoluteFill, clearance.leftShift]} pointerEvents="box-none">
        <PeekCoversCards.Provider value={clearance.coversLeft}>
          <CheckInBanner windowId={windowId} />
          <TelemetryAsk windowId={windowId} size={size} bar={bar} />
        </PeekCoversCards.Provider>
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, clearance.rightShift]} pointerEvents="box-none">
        {incognito ? null : <PersonalizeButton windowId={windowId} />}
        {pending && !incognito && !page ? (
          <ReleaseNotesPostcard notes={pending} size={size} onOpen={() => openReleaseNotes(windowId)} onDismiss={retireReleaseNotes} />
        ) : null}
      </Animated.View>
      {page ? <ReleaseNotesPage notes={page} size={size} onClose={closeReleaseNotes} /> : null}
    </View>
  );
}
