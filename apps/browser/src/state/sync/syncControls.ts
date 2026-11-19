import { PLATFORM_TERMS } from "../../lib/platformTerms";
import type { SyncUi } from "./syncDoc";

export type SyncPrimaryAction = "resume" | "phrase" | "connect";
export type SyncAdvancedAction = "kit" | "copy" | "now" | "reveal" | "stop";

export type SyncControls = {
  primary: SyncPrimaryAction;
  resuming: boolean;
  advanced: SyncAdvancedAction[];
  keyActions: boolean;
  editable: boolean;
  stopOffersDelete: boolean;
  stopOffersKit: boolean;
};

export const STOP_WHILE_PAUSED = `Changes this ${PLATFORM_TERMS.computer} hadn’t uploaded yet won’t reach your other devices.`;

export function syncControls({ status, paused }: Pick<SyncUi, "status" | "paused">): SyncControls {
  const locked = status === "locked";
  const resuming = status === "resuming";
  if (paused || resuming) {
    return { primary: locked ? "phrase" : "resume", resuming, advanced: resuming ? [] : ["stop"], keyActions: false, editable: false, stopOffersDelete: false, stopOffersKit: false };
  }
  return { primary: locked ? "phrase" : "connect", resuming: false, advanced: ["kit", "copy", "now", "reveal", "stop"], keyActions: !locked, editable: true, stopOffersDelete: true, stopOffersKit: true };
}
