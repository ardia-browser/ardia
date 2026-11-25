import { memo, useEffect, useMemo, useRef } from "react";
import { StyleSheet } from "react-native";
import { parseColor } from "../../lib/color";
import { fieldGlow, fieldGlowAvailable } from "../../state/tabs/fieldGlow";
import { FieldGlowView, type FieldGlowLook } from "../ui";
import { driveFieldLoad, type LoadSink } from "./fieldLoadDrive";
import { FIELD_LOAD } from "./tokens";

export type FieldLoadFillProps = { tabId: string; color: string; height: number; radius: number };

const { motion } = FIELD_LOAD;
export const FIELD_GLOW_TIMINGS = [motion.show.duration, motion.progress.duration, motion.finish.duration, motion.hold, motion.hide.duration];
const Host = fieldGlowAvailable ? FieldGlowView() : null;
const RUNTIME = Math.random().toString(36).slice(2, 10);
let glows = 0;

export const nativeSink = (id: string): LoadSink => ({
  show: () => fieldGlow?.show(id, FIELD_GLOW_TIMINGS),
  progress: (progress, still) => fieldGlow?.progress(id, progress, still),
  pulse: (on) => fieldGlow?.pulse?.(id, on ? FIELD_LOAD.pulse.period : 0, FIELD_LOAD.pulse.low),
  finish: (still) => fieldGlow?.finish(id, still),
  reset: () => fieldGlow?.reset(id),
});

export const fieldGlowLook = (color: string): FieldGlowLook => ({
  rgba: parseColor(color),
  glow: FIELD_LOAD.glow.map(([at, alpha]) => [at, alpha]),
  tailFade: [...FIELD_LOAD.tailFade],
  capFade: [...FIELD_LOAD.capFade],
  tail: FIELD_LOAD.tail,
  cap: FIELD_LOAD.cap,
  frontShare: FIELD_LOAD.frontShareOfField,
  tailCeiling: FIELD_LOAD.tailCeiling,
  line: FIELD_LOAD.line,
  floor: FIELD_LOAD.floor,
});

export const FieldGlowFill = memo(function FieldGlowFill({ tabId, color, radius }: FieldLoadFillProps) {
  const id = useRef(`glow-${RUNTIME}-${++glows}`).current;
  const look = useMemo(() => fieldGlowLook(color), [color]);

  useEffect(() => {
    const drive = driveFieldLoad(tabId, nativeSink(id));
    return drive.stop;
  }, [tabId]);

  if (!Host) return null;
  return <Host pointerEvents="none" glowId={id} radius={radius} look={look} style={StyleSheet.absoluteFill} />;
});
