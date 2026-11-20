import type { Fiber } from "./fiber";
import { noteTitleBandPress } from "./titleBandCounts";

export type Press = { target?: unknown; nativeEvent: { pageX: number; pageY: number } };

type Props = Record<string, unknown>;

export type HostFiber = Fiber & {
  tag: number;
  type: unknown;
  return: HostFiber | null;
  memoizedProps?: Props | null;
  stateNode?: { canonical?: { currentProps?: Props | null; nativeTag?: number; publicInstance?: unknown } | null } | null;
};

const TITLE_BAND_HEIGHT = 32;
const HOST_COMPONENT = 5;
const MOST_ANCESTORS = 512;
const TEXT_FIELD_HOST = /TextInput/;

export function hostPath(target: HostFiber | null | undefined): HostFiber[] {
  const path: HostFiber[] = [];
  let fiber = target ?? null;
  for (let steps = 0; fiber && steps < MOST_ANCESTORS; steps++, fiber = fiber.return) {
    if (fiber.tag === HOST_COMPONENT) path.push(fiber);
  }
  return path;
}

export const fiberOf = (instance: unknown) => (instance as { __internalInstanceHandle?: HostFiber | null } | null)?.__internalInstanceHandle ?? null;

export const inTitleBand = (press: Press) => press.nativeEvent.pageY <= TITLE_BAND_HEIGHT;

export const pressOnTextField = (press: Press) =>
  hostPath(fiberOf(press.target)).some((fiber) => typeof fiber.type === "string" && TEXT_FIELD_HOST.test(fiber.type));

export function claimsTitleBandPress(press: Press): boolean {
  if (!inTitleBand(press)) return false;
  const taken = !pressOnTextField(press);
  noteTitleBandPress(taken ? "taken" : "leftToText");
  return taken;
}
