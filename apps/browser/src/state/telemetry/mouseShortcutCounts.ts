import type { MouseShortcutButton } from "../../platform/commands";
import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

const FIELDS: Record<MouseShortcutButton, string> = {
  middle: "mouse_shortcut_runs_middle",
  button4: "mouse_shortcut_runs_button4",
  button5: "mouse_shortcut_runs_button5",
};
const NO_RUNS = { mouse_shortcut_runs_middle: 0, mouse_shortcut_runs_button4: 0, mouse_shortcut_runs_button5: 0 };
let runs: Record<string, number> = { ...NO_RUNS };

export function noteMouseShortcutRun(button: string | null | undefined, consent: ConsentToken | null) {
  if (!button || !Object.hasOwn(FIELDS, button)) return;
  const field = FIELDS[button as MouseShortcutButton];
  countFor(consent, () => void (runs[field] = (runs[field] ?? 0) + 1));
}

export function takeMouseShortcutCounts() {
  const taken = runs;
  runs = { ...NO_RUNS };
  return taken;
}
