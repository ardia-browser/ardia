import { consentedCount } from "./consentedCount";
import { countFor, type ConsentToken } from "./consentPeriod";

type Layout = "sidebar" | "strip";
type Kind = "open" | "close" | "interrupt" | "overrun";

const counts = {
  sidebar: { open: consentedCount(), close: consentedCount(), interrupt: consentedCount(), overrun: consentedCount() },
  strip: { open: consentedCount(), close: consentedCount(), interrupt: consentedCount(), overrun: consentedCount() },
} as const;

export function noteTabMotion(consent: ConsentToken | null, layout: Layout, kind: Kind, times = 1) {
  countFor(consent, () => {
    for (let i = 0; i < times; i++) counts[layout][kind].note();
  });
}

export function takeTabMotionCounts() {
  return {
    sidebar_tab_open_motions: counts.sidebar.open.take(),
    sidebar_tab_close_motions: counts.sidebar.close.take(),
    sidebar_tab_motion_interrupts: counts.sidebar.interrupt.take(),
    tab_strip_open_motions: counts.strip.open.take(),
    tab_strip_close_motions: counts.strip.close.take(),
    tab_strip_motion_interrupts: counts.strip.interrupt.take(),
    tab_strip_motion_overruns: counts.strip.overrun.take(),
  };
}
