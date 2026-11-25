import { discardOffered, type OpenWindowRequest } from "../../platform/tabs";
import { focus, openWindow } from "../browser/actions";
import { engineProfile } from "../browser/model";
import { useBrowser } from "../browser/store";
import { isOpenRegularWindow } from "../windows/small";
import { asAdoptId } from "./adoptIds";
import { openFromPage } from "./openFromPage";

type Disposition = OpenWindowRequest["disposition"];

const NEEDS_A_TAB = new Set<Disposition>(["current", "peek"]);
const INTO_THE_WINDOW = new Set<Disposition>(["foreground", "split"]);

const dropOffered = (request: OpenWindowRequest) => {
  if (request.adoptId) void discardOffered(request.adoptId).catch(() => false);
};

export function openFromWindowlessPage(asked: OpenWindowRequest, profile: string, fromWindow?: string) {
  const request: OpenWindowRequest = NEEDS_A_TAB.has(asked.disposition) ? { ...asked, disposition: "foreground" } : asked;
  const s = useBrowser.getState();
  const spaceId = s.spaceOrder.find((id) => engineProfile(s, id) === profile);
  if (!spaceId) return dropOffered(request);
  const windowId = [...new Set([...s.ui.focusOrder, ...s.windowOrder])].find((id) => isOpenRegularWindow(s.windows[id]) && s.windows[id]!.spaceId === spaceId);
  if (windowId) {
    openFromPage(request, { windowId, spaceId });
    if (INTO_THE_WINDOW.has(request.disposition)) focus(windowId);
    return;
  }
  if (request.disposition === "incognito") {
    dropOffered(request);
    return void openWindow({ kind: "private", url: request.url, spaceId });
  }
  const behind = request.disposition === "background" && fromWindow ? { opensBehind: fromWindow } : {};
  openWindow({ url: request.url, adoptId: asAdoptId(request.adoptId), spaceId, ...behind });
}
