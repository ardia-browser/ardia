import { on } from "@ardia/ardiacore";
import { noteLoginPasswordCheck } from "../../browser/src/state/telemetry/updateCounts.ts";

type ReauthEvent = { method?: string; result?: string };

export function countLoginPasswordChecks(leading: () => boolean, subscribe: (listener: (event: ReauthEvent) => void) => unknown = (listener) => on("reauth.requested", listener)) {
  subscribe((event) => {
    if (event?.method === "loginPassword" && leading()) noteLoginPasswordCheck(event.result);
  });
}
