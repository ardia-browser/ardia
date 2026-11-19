import { readDocument } from "../../platform/documents";
import { bucket } from "./journeys";

export const LAUNCH_GUARD_DOC = "launch-guard.json";

type LastQuitAnswer = "yes" | "timeout" | "none";
type LastQuitReason = "user" | "update";

type LaunchGuardProperties = {
  launch_waited_for_previous?: string;
  launch_unfinished_starts_before?: number;
  launch_restore_state_set_aside?: boolean;
  launch_profile_held_by_another?: boolean;
  launch_refused_starts_before?: number;
  launch_restarted_after_refusal?: boolean;
  launch_last_quit_wait?: string;
  launch_last_quit_answer?: LastQuitAnswer;
  launch_last_quit_reason?: LastQuitReason;
  launch_quits_cancelled_by_launch?: number;
};

const LAST_QUIT_ANSWERS = new Set<string>(["yes", "timeout", "none"]);
const LAST_QUIT_REASONS = new Set<string>(["user", "update"]);

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);

export const waitedForPreviousBucket = (ms: number) =>
  bucket(ms, [[0, "0"], [999, "<1s"], [2999, "<3s"], [9999, "<10s"], [29_999, "<30s"], [44_999, "<45s"]], "45s+");

export const quitWaitBucket = (ms: number) => bucket(ms, [[99, "<100ms"], [499, "<500ms"], [999, "<1s"], [1999, "<2s"], [2999, "<3s"]], "3s+");

export function launchGuardProperties(read: (name: string) => string | null = readDocument): LaunchGuardProperties {
  let saved: unknown;
  try {
    const raw = read(LAUNCH_GUARD_DOC);
    if (!raw) return {};
    saved = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!saved || typeof saved !== "object") return {};
  const facts = saved as Record<string, unknown>;
  const properties: LaunchGuardProperties = {};
  const waited = count(facts.waitedForPreviousMs);
  const unfinished = count(facts.unfinishedStartsBefore);
  const refused = count(facts.refusedStartsBefore);
  const quitWait = count(facts.lastQuitWaitMs);
  const cancelledByLaunch = count(facts.quitsCancelledByLaunch);
  if (waited !== undefined) properties.launch_waited_for_previous = waitedForPreviousBucket(waited);
  if (unfinished !== undefined) properties.launch_unfinished_starts_before = unfinished;
  if (typeof facts.restoreStateSetAside === "boolean") properties.launch_restore_state_set_aside = facts.restoreStateSetAside;
  if (typeof facts.profileHeldByAnother === "boolean") properties.launch_profile_held_by_another = facts.profileHeldByAnother;
  if (refused !== undefined) properties.launch_refused_starts_before = refused;
  if (typeof facts.restartedAfterRefusal === "boolean") properties.launch_restarted_after_refusal = facts.restartedAfterRefusal;
  if (quitWait !== undefined && typeof facts.lastQuitAnswer === "string" && LAST_QUIT_ANSWERS.has(facts.lastQuitAnswer)) {
    properties.launch_last_quit_wait = quitWaitBucket(quitWait);
    properties.launch_last_quit_answer = facts.lastQuitAnswer as LastQuitAnswer;
    if (typeof facts.lastQuitReason === "string" && LAST_QUIT_REASONS.has(facts.lastQuitReason)) properties.launch_last_quit_reason = facts.lastQuitReason as LastQuitReason;
    if (cancelledByLaunch !== undefined) properties.launch_quits_cancelled_by_launch = cancelledByLaunch;
  }
  return properties;
}
