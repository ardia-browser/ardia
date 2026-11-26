import { Pager, type NativePagerFrame } from "./pager";
import { PAGER_PHASES, type PagerPhase } from "./pagerSpring";

export const PAGER_FRAME_EVENT = "onPagerFrame";
const MAX_KEY_LENGTH = 256;
const MAX_PROFILE_ID_LENGTH = 256;
const MAX_POSITION = 1 << 20;
const MAX_VELOCITY = 1 << 10;

export type HostPagerFrame = NativePagerFrame & { key: string };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown, limit: number): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
const wholeAtLeast = (value: unknown, min: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const flag = (value: unknown) => value === true;
const TOKEN = /^[A-Za-z0-9_.:-]+$/;
const token = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && TOKEN.test(value);
const own = (record: Record<string, unknown>, camel: string, snake: string) =>
  Object.hasOwn(record, camel) ? record[camel] : Object.hasOwn(record, snake) ? record[snake] : undefined;

export function readPagerFrame(value: unknown): HostPagerFrame | null {
  if (!isRecord(value)) return null;
  const key = value.key;
  const phase = value.phase;
  const count = value.count;
  const selected = value.selected;
  const sequence = value.sequence;
  const frameNumber = value.frame;
  const selectionSequence = own(value, "selectionSequence", "selection_sequence");
  if (!token(key, MAX_KEY_LENGTH)) return null;
  if (typeof phase !== "string" || !PAGER_PHASES.includes(phase as PagerPhase)) return null;
  if (!wholeAtLeast(count, 1) || !wholeAtLeast(selected, 0) || selected >= count) return null;
  if (!wholeAtLeast(sequence, 0) || !wholeAtLeast(selectionSequence, 0) || !wholeAtLeast(frameNumber, 1)) return null;
  if (!finite(value.position, MAX_POSITION)) return null;
  const velocity = value.velocity === undefined ? 0 : value.velocity;
  if (!finite(velocity, MAX_VELOCITY)) return null;
  const rawProfile = own(value, "profileId", "profile_id");
  if (rawProfile !== undefined && rawProfile !== null && !token(rawProfile, MAX_PROFILE_ID_LENGTH)) return null;
  const frame: HostPagerFrame = {
    key,
    frame: frameNumber,
    sequence,
    selectionSequence,
    position: value.position,
    velocity,
    phase: phase as PagerPhase,
    selected,
    count,
    began: flag(value.began),
    selectedChanged: flag(own(value, "selectedChanged", "selected_changed")),
    settled: flag(value.settled),
    detentCrossed: flag(own(value, "detentCrossed", "detent_crossed")),
  };
  if (typeof rawProfile === "string") frame.profileId = rawProfile;
  return frame;
}

export function onPagerFrame(value: unknown) {
  const frame = readPagerFrame(value);
  if (!frame) return false;
  return Pager.existing(frame.key)?.applyNativeFrame(frame) ?? false;
}
