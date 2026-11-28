import type { MouseGestureAction } from "../../platform/commands";
import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

const ACTIONS: readonly MouseGestureAction[] = ["back", "forward", "reload", "close_tab", "reopen_closed_tab", "new_tab", "previous_tab", "next_tab"];
const noRuns = () => Object.fromEntries(ACTIONS.map((action) => [`mouse_gesture_runs_${action}`, 0])) as Record<string, number>;
let runs = noRuns();

export function noteMouseGestureRun(action: string | null | undefined, consent: ConsentToken | null) {
  if (!action || !ACTIONS.includes(action as MouseGestureAction)) return;
  const field = `mouse_gesture_runs_${action}`;
  countFor(consent, () => void (runs[field] = (runs[field] ?? 0) + 1));
}

export function takeMouseGestureCounts() {
  const taken = runs;
  runs = noRuns();
  return taken;
}
