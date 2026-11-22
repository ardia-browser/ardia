import { dismissWords } from "../../lib/sharedWords.ts";

export type ToastAnnouncement = "announceForAccessibility" | "liveRegion";

export type ToastSemantics = {
  pressable: boolean;
  role: "button" | "alert";
  announcement: ToastAnnouncement;
  liveRegion: "polite" | "none";
  actions: { name: string; label: string }[];
  escapes: boolean;
};

export const TOAST_DISMISS_ACTION = "dismiss";

export function toastSemantics(actionLabel: string | null, os: string): ToastSemantics {
  const hasAction = actionLabel !== null;
  const announcement: ToastAnnouncement = os === "ios" ? "announceForAccessibility" : "liveRegion";
  return {
    pressable: hasAction,
    role: hasAction ? "button" : "alert",
    announcement,
    liveRegion: announcement === "liveRegion" ? "polite" : "none",
    actions: [{ name: TOAST_DISMISS_ACTION, label: dismissWords.close }],
    escapes: true,
  };
}

export const toastSpokenLabel = (message: string, actionLabel: string | null) => (actionLabel === null ? message : `${message}, ${actionLabel}`);

export const toastAnnouncement = toastSpokenLabel;

export const dismissesToast = (actionName: string) => actionName === TOAST_DISMISS_ACTION;

export function toastDragReturn(reduceMotion: boolean): "snap" | "spring" {
  "worklet";
  return reduceMotion ? "snap" : "spring";
}
