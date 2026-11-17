import { isSharing } from "./choice";

export const POPUP_ANSWERS = ["only_once", "always_allow", "always_deny", "dismissed"] as const;
export type PopupAnswer = (typeof POPUP_ANSWERS)[number];

const COUNT_KEYS = {
  blocked: "popups_blocked",
  asked: "popup_prompts_asked",
  auto_handled: "popups_auto_handled",
  only_once: "popup_answers_only_once",
  always_allow: "popup_answers_always_allow",
  always_deny: "popup_answers_always_deny",
  dismissed: "popup_answers_dismissed",
} as const;

type Count = keyof typeof COUNT_KEYS;
type Tally = Record<Count, number>;

const COUNTS = Object.keys(COUNT_KEYS) as Count[];
const empty = (): Tally => ({ blocked: 0, asked: 0, auto_handled: 0, only_once: 0, always_allow: 0, always_deny: 0, dismissed: 0 });

let pending = empty();
const session = empty();
let last: Count | null = null;

function note(count: Count) {
  session[count]++;
  last = count;
  if (isSharing()) pending[count]++;
}

export const notePopupBlocked = () => note("blocked");

export const notePopupPrompt = (asked: boolean) => note(asked ? "asked" : "auto_handled");

export const notePopupAnswer = (answer: PopupAnswer) => note(answer);

export function takePopupBlockCounts(): Record<string, number> {
  const taken = pending;
  pending = empty();
  const out: Record<string, number> = {};
  if (isSharing()) for (const count of COUNTS) if (taken[count]) out[COUNT_KEYS[count]] = taken[count];
  return out;
}

export function popupBlockLine() {
  const parts = COUNTS.map((count) => `${count.replace("_", " ")} ${session[count]}`);
  return `Blocked pop-ups this session: ${parts.join(", ")}; last: ${last ? last.replace("_", " ") : "none"}`;
}
