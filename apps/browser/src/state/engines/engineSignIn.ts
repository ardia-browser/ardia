import type { PageEngine } from "../../platform/tabs";
import { withDeadline } from "../../lib/deadline";
import { noteCookiesCarried } from "../telemetry/engineSwitchCounts";
import type { ConsentToken } from "../telemetry/client";
import { carryForTab } from "./siteData";

const CARRY_DEADLINE_MS = 1500;

type StillWanted = () => boolean;
const always: StillWanted = () => true;

export async function carrySignIn(tabId: string, url: string, to: PageEngine, consent: ConsentToken | null, wanted: StillWanted = always): Promise<number> {
  let expired = false;
  const count = await withDeadline(
    carryForTab(tabId, url, to, () => !expired && wanted(), consent).catch(() => 0),
    CARRY_DEADLINE_MS,
    null,
  );
  expired = true;
  noteCookiesCarried(to, count ?? 0, consent);
  return count ?? 0;
}
