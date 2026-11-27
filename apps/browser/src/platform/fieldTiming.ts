import { NativeModules } from "react-native";

export type FieldTiming = {
  pageMarks?: boolean;
  setEnabled(on: boolean): void;
  markFrame(key: string, kind: string): void;
  lastInput(): [at: number, kind: number];
  drain(): [key: string, kind: string, at: number][];
};

export const fieldTiming = NativeModules.ACFieldTiming as FieldTiming;
