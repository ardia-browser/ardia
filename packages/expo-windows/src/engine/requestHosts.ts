import type { OpenWindowRequest, WindowRequest } from "@ardia/ardiacore";
import { emitWhenListened } from "../events";
import { takerOfOpenedTab } from "./openedTabs";
import type { Page } from "./pages";
import { isPopupWindowId } from "./popupWindows";
import { isPrivateName } from "./privateWindows";

export type RequestPage = Pick<Page, "key" | "profile" | "windowId" | "closed" | "listeners">;

export const BROWSER_WINDOW_WAIT_MS = 10000;

type Unadopted = { timer: ReturnType<typeof setTimeout>; giveUp: () => void };

const unadopted = new Map<string, Unadopted>();

const listens = (page: RequestPage | undefined): page is RequestPage => !!page && page.listeners.size > 0 && !page.closed && !isPopupWindowId(page.windowId);

export const listeningBrowserPages = <Candidate extends RequestPage>(all: Iterable<Candidate>): Candidate[] => [...all].filter(listens);

const servesProfile = (page: RequestPage, profile: string | undefined) => profile === undefined || takerOfOpenedTab([page], profile) === page;

export function requestHost<Candidate extends RequestPage>(opener: Candidate | undefined, profile: string | undefined, all: Iterable<Candidate>): Candidate | undefined {
  if (listens(opener) && servesProfile(opener, profile)) return opener;
  return takerOfOpenedTab(listeningBrowserPages(all), profile);
}

export const asOpenWindowRequest = (value: unknown): OpenWindowRequest | null =>
  typeof value === "object" && value !== null && typeof (value as OpenWindowRequest).url === "string" ? (value as OpenWindowRequest) : null;

export function openInBrowserWindow(request: OpenWindowRequest, profile: string, fromWindow: string, giveUp: () => void) {
  if (isPrivateName(profile)) return giveUp();
  const { adoptId } = request;
  if (adoptId) {
    const timer = setTimeout(() => {
      unadopted.delete(adoptId);
      giveUp();
    }, BROWSER_WINDOW_WAIT_MS);
    clearTimeout(unadopted.get(adoptId)?.timer);
    unadopted.set(adoptId, { timer, giveUp });
  }
  emitWhenListened("ArdiaTabs", "tabs", { name: "tabs.windowRequest", data: { request, profile, fromWindow } satisfies WindowRequest });
}

export function offeredTabAdopting(adoptId: string | undefined): (adopted: boolean) => void {
  const waiting = adoptId === undefined ? undefined : unadopted.get(adoptId);
  if (!waiting || adoptId === undefined) return () => {};
  clearTimeout(waiting.timer);
  unadopted.delete(adoptId);
  return (adopted) => {
    if (!adopted) waiting.giveUp();
  };
}
