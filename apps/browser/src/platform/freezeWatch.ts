import { DeviceEventEmitter, NativeModules } from "react-native";

export type StallTally = {
  buckets: number[];
  longestMs: number;
  inputWaits: number;
  inputWaitMaxMs: number;
  gcMeasured: number;
  gcMs: number;
  gcLongestMs: number;
  gcBound: number;
};

type FreezeWatch = {
  start(): boolean;
  setConsentEpoch(epoch: number): boolean;
  take(epoch: number): { main: StallTally; js: StallTally } | null;
  annotate(freezeId: number, activity: string): boolean;
};

export type FreezeFrame = { image: string; offset: number };
type FreezeSample = { state: number; frames: FreezeFrame[] };
export type FreezeRecord = {
  id: number;
  thread: "main" | "js";
  startedAt: number;
  durationMs: number;
  inputWaitMs: number;
  gcMs: number;
  gcCount: number;
  thermal: number;
  epoch: string;
  watchEpoch: number;
  samples: FreezeSample[];
  images: { name: string; uuid: string }[];
};

export const freezeWatch = () => (NativeModules.ACFreezeWatch as FreezeWatch | undefined) ?? null;

export function onFreeze(listener: (record: FreezeRecord) => void): () => void {
  const subscription = DeviceEventEmitter.addListener("ardiaFreeze", listener);
  return () => subscription.remove();
}
