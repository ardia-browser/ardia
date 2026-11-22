import { canDismissShownOnlyDialogs, confirm, dismissShownOnlyDialogs } from "../../platform/dialogs";
import type { CloseAsk } from "../windows/windowClose";
import { lastFocusedEligibleWindow } from "./automationWindows";
import { now } from "./socketTargets";
import { OpError } from "./workspaceTargets";
import { STOPPED, type SocketCall } from "./socketCatalog";
import { t } from "../../lib/uiLanguage";


export const UNSEEN = t(`Ardia would have to ask first, and nobody can see that question here (its window isn't on screen, or Ardia runs in the background)`);

type Waiting = { connection: number; key: string; dismiss: () => void };

const waiting = new Set<Waiting>();
let asked = 0;

export function askWhereSeen(outcome: string, call: SocketCall): CloseAsk {
  return async (options) => {
    if (!call.serving()) throw new OpError("failed", STOPPED);
    const entry: Waiting = { connection: call.connection, key: `socket-${call.connection}-${++asked}`, dismiss: () => {} };
    const dismissed = new Promise<"dismissed">((resolve) => (entry.dismiss = () => resolve("dismissed")));
    waiting.add(entry);
    try {
      const answer = await Promise.race([confirm({ ...options, onlyIfShown: true, dismissKey: entry.key }), dismissed]);
      if (answer === "dismissed") throw new OpError("refused", `${outcome}: the client left or control was turned off before anyone answered, so Ardia took the question away.`);
      if (answer.unshown) throw new OpError("refused", `${outcome}: ${UNSEEN}.`);
      return answer;
    } finally {
      waiting.delete(entry);
    }
  };
}

export function dismissSocketAsks(connection?: number) {
  if (!canDismissShownOnlyDialogs()) return;
  for (const entry of [...waiting]) {
    if (connection !== undefined && entry.connection !== connection) continue;
    void dismissShownOnlyDialogs(entry.key).then(entry.dismiss, () => {});
  }
}

export const shownWindowId = (): string | undefined => lastFocusedEligibleWindow(now()) ?? undefined;
