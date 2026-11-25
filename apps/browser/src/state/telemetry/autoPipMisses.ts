import { counted } from "./choice";
import { nativeConsent } from "./nativeConsent";

const MISS_FIELDS = {
  missedTabSwitch: "auto_pip_not_shown_tab_switch",
  missedAppSwitch: "auto_pip_not_shown_app_switch",
  missedSpaceSwitch: "auto_pip_not_shown_space_switch",
  missedOther: "auto_pip_not_shown_other",
  missedSiteAsked: "auto_pip_not_shown_site_asked",
  leftOnSpaceSwitch: "pip_left_on_space_switch",
  leftOnSpaceSwitchJoining: "pip_left_on_space_switch_joining",
} as const;

export type AutoPipMiss = keyof typeof MISS_FIELDS;

const none = () => Object.fromEntries(Object.values(MISS_FIELDS).map((field) => [field, 0])) as Record<(typeof MISS_FIELDS)[AutoPipMiss], number>;

let misses = none();

export const isAutoPipMiss = (reason: string): reason is AutoPipMiss => Object.hasOwn(MISS_FIELDS, reason);

export const noteAutoPipMiss = (reason: AutoPipMiss, epoch: string) => counted(nativeConsent({ epoch }), () => void misses[MISS_FIELDS[reason]]++);

export function takeAutoPipMisses() {
  const taken = misses;
  misses = none();
  return taken;
}
