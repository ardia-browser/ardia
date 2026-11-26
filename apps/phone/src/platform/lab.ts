import { labFrameMark, labLog, labSlice, lookLab } from "@ardia/phone-native";

export { labLog };

export const isLabBuild = process.env.EXPO_PUBLIC_ARDIA_LAB === "true";

let tracing = isLabBuild;
let traceSink: (line: string) => void = labLog;

export function traceLab(on: boolean, sink: (line: string) => void = labLog) {
  tracing = on;
  traceSink = sink;
}

export const labTrace = (line: string) => {
  if (tracing) traceSink(line);
};

export const traceSlice = (label: string) => {
  if (isLabBuild) labSlice(label);
};

export const markShownFrame = (label: string) => {
  if (isLabBuild) labFrameMark(label);
};

export function lookActivity(): { recording: number; holdingLayers: number; animating: number } | null {
  const counts = lookLab.counts();
  return counts ? { recording: counts.recording, holdingLayers: counts.holdingLayers, animating: counts.animating } : null;
}

export function lookTotals(): { backdropFrames: number; sourceRecordings: number; blurLayerRenders: number; retints: number } | null {
  const counts = lookLab.counts();
  if (!counts) return null;
  const { backdropFrames, sourceRecordings, blurLayerRenders, retints } = counts;
  if (backdropFrames === undefined || sourceRecordings === undefined || blurLayerRenders === undefined || retints === undefined) return null;
  return { backdropFrames, sourceRecordings, blurLayerRenders, retints };
}
