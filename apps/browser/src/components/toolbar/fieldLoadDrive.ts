import { watchLastingLoad } from "../../state/tabs/lastingLoad";
import { pageProgressOf, watchPageProgress } from "../../state/tabs/pageProgress";
import { notePageOverlay } from "../../state/telemetry/usage";
import { reduceMotion, type GradientStop } from "../ui";
import { FIELD_LOAD } from "./tokens";

export const lined = (glow: readonly GradientStop[], height: number): GradientStop[] => {
  const lineTop = 1 - FIELD_LOAD.line / height;
  return [...glow.map(([at, alpha]) => [at * lineTop, alpha] as const), [lineTop, 1], [1, 1]];
};
const TAIL_GLOW: GradientStop[] = FIELD_LOAD.glow.map(([at, alpha]) => [at, Math.min(alpha, FIELD_LOAD.tailCeiling)]);
const CAP_GLOW: GradientStop[] = FIELD_LOAD.glow.map(([at, alpha]) => [at, alpha - Math.min(alpha, FIELD_LOAD.tailCeiling)]);
export const fadingPast = (body: number, front: number, falloff: readonly number[]): GradientStop[] => [
  [0, 1],
  ...falloff.map((alpha, i) => [(body + (front * i) / (falloff.length - 1)) / (body + front), alpha] as const),
];

export const frontOf = (width: number) => {
  const scale = Math.min(1, (width * FIELD_LOAD.frontShareOfField) / FIELD_LOAD.tail);
  return { tail: FIELD_LOAD.tail * scale, cap: FIELD_LOAD.cap * scale };
};

type FieldLoadPlates = { tail: { stops: GradientStop[]; fade: GradientStop[]; extra: number }; cap: { stops: GradientStop[]; fade: GradientStop[]; extra: number }; comet: { stops: GradientStop[]; fade: GradientStop[]; extra: number } };

export function fieldLoadPlates(width: number, height: number): FieldLoadPlates {
  const { tail, cap } = frontOf(width);
  const capFade = fadingPast(width, cap, FIELD_LOAD.capFade);
  return {
    tail: { stops: TAIL_GLOW, fade: fadingPast(width, tail, FIELD_LOAD.tailFade), extra: tail },
    cap: { stops: lined(CAP_GLOW, height), fade: capFade, extra: cap },
    comet: { stops: lined(FIELD_LOAD.glow, height), fade: [[0, 0], ...capFade.slice(1)], extra: cap },
  };
}

export type LoadSink = { show(): void; progress(progress: number, still: boolean): void; finish(still: boolean): void; reset(): void };
export type Front = { width: number; tail: number };

export const filledAt = (progress: number, { width, tail }: Front) => Math.max(FIELD_LOAD.floor, Math.min(progress, 1 - tail / width));

export function driveFieldLoad(tabId: string, sink: LoadSink): { refit: () => void; stop: () => void } {
  let shown = false;
  let stopped = false;
  const refit = () => {
    if (stopped || !shown) return;
    sink.progress(pageProgressOf(tabId), !!reduceMotion());
  };
  const show = () => {
    if (stopped) return;
    shown = true;
    notePageOverlay("loadingField");
    sink.show();
    refit();
  };
  const finish = () => {
    if (stopped) return;
    shown = false;
    sink.finish(!!reduceMotion());
  };
  const stopLoad = watchLastingLoad(tabId, (lasting) => (lasting ? show() : finish()));
  const stopProgress = watchPageProgress(tabId, refit);
  return {
    refit,
    stop: () => {
      stopped = true;
      stopLoad();
      stopProgress();
      sink.reset();
    },
  };
}
