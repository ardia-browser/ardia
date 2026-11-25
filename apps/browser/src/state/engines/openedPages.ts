import type { PageEngine } from "../../platform/tabs";
import type { Tab } from "../browser/types";
import { useBrowser } from "../browser/store";
import { tabEngine } from "./engines";
import { webviews } from "../../platform/webviews";
import { withDeadline } from "../../lib/deadline";
import { adoptKind } from "../tabs/adoptIds";
import { adoptOf } from "../tabs/pageSession";

export type OpenerState = "live" | "none" | "unknown";

const pageMade = new Map<string, PageEngine>();
let unwatch: (() => void) | null = null;

function forgetReplacedPages() {
  unwatch ??= useBrowser.subscribeTo(["tabs"], (s) => {
    for (const [id, engine] of pageMade) if (!s.tabs[id] || tabEngine(s, id) !== engine) pageMade.delete(id);
  });
}

export function madeByPage(t: Tab | undefined): boolean {
  const kind = t?.page.kind === "adopted" ? adoptKind(adoptOf(t))?.kind : undefined;
  return kind === "ardiacore" || kind === "webkit";
}

export function notePageMadeTab(tabId: string) {
  const s = useBrowser.getState();
  if (!s.tabs[tabId]) return;
  pageMade.set(tabId, tabEngine(s, tabId));
  forgetReplacedPages();
}

export function openedByPage(tabId: string): boolean {
  const s = useBrowser.getState();
  const t = s.tabs[tabId];
  if (madeByPage(t)) return true;
  const engine = pageMade.get(tabId);
  return !!t && engine !== undefined && tabEngine(s, tabId) === engine;
}

export const forgetPageMadeTab = (tabId: string) => void pageMade.delete(tabId);

const HAS_OPENER = `post("result", window.opener ? "true" : "false")`;
const OPENER_CHECK_MS = 400;
const OPENER_RETRY_MS = 250;
const OPENER_GIVE_UP_MS = 4000;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const openerAnswer = (answer: unknown): OpenerState => (answer === true ? "live" : answer === false ? "none" : "unknown");

export async function openerState(tabId: string, stillWanted: () => boolean): Promise<OpenerState> {
  const until = Date.now() + OPENER_GIVE_UP_MS;
  while (stillWanted()) {
    const web = webviews.get(tabId);
    const state = openerAnswer(web ? await withDeadline(web.evaluate<unknown>(HAS_OPENER).catch(() => null), OPENER_CHECK_MS, null) : null);
    if (state !== "unknown") return state;
    if (Date.now() + OPENER_RETRY_MS > until) return "unknown";
    await pause(OPENER_RETRY_MS);
  }
  return "unknown";
}
