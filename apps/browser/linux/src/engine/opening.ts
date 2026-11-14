import { app, type WebContents } from "electron";
import { guestOf, tell, windowOf, type Guest } from "./guests";
import { definePageCall } from "./pageCalls";
import { block, consumeActivation, forgetBlocked, mayOpen, takeBlocked, takeDrop } from "./popupBlocker";
import { openPopupWindow, parseFeatures, popupWindowCreator } from "./popupWindows";

type Disposition = "default" | "foreground-tab" | "background-tab" | "new-window" | "other";

function openAsTab(guest: Guest, url: string, disposition: string, fromClick: boolean, postBody: boolean) {
  tell(guest, "openWindow", { url, disposition, userGesture: true, fromClick, postBody });
}

const looksLikePopup = (features: string) => /(^|,)\s*(width|height|popup)\s*=/i.test(features);

const tabKindOf = (kind: Disposition) => (kind === "background-tab" ? "background" : kind === "new-window" ? "window" : "foreground");

function popupOptions(opener: Guest, features: string) {
  return {
    features: parseFeatures(features),
    parent: windowOf(opener),
    openAsTab: (url: string) => {
      if (!opener.contents.isDestroyed()) openAsTab(opener, url, "foreground", false, false);
    },
    wire: (contents: WebContents) => handlePopupOpens(contents, opener),
  };
}

function handlePopupOpens(popup: WebContents, opener: Guest) {
  popup.setWindowOpenHandler(({ url, features, disposition }) => {
    if (opener.contents.isDestroyed()) return { action: "deny" };
    if (!consumeActivation(popup) && !mayOpen(opener)) {
      block(opener, url, features, disposition);
      return { action: "deny" };
    }
    if (disposition === "new-window" && looksLikePopup(features))
      return { action: "allow", outlivesOpener: false, createWindow: popupWindowCreator(popupOptions(opener, features)) };
    openAsTab(opener, url, tabKindOf(disposition as Disposition), false, false);
    return { action: "deny" };
  });
}

function openBlocked(guest: Guest, id: string, always: boolean): boolean {
  const entry = takeBlocked(guest, id, always);
  if (!entry) return false;
  const kind = entry.disposition as Disposition;
  if (kind === "new-window" && looksLikePopup(entry.features)) openPopupWindow(entry.url, guest.contents.session, popupOptions(guest, entry.features));
  else openAsTab(guest, entry.url, tabKindOf(kind), false, false);
  return true;
}

function handleOpen(contents: WebContents) {
  contents.setWindowOpenHandler(({ url, features, disposition, postBody, referrer }) => {
    const guest = guestOf(contents);
    if (!guest) return { action: "deny" };
    const kind = disposition as Disposition;
    if (!takeDrop(contents, referrer.url) && !mayOpen(guest)) {
      block(guest, url, features, kind);
      return { action: "deny" };
    }
    if (kind === "new-window" && looksLikePopup(features))
      return { action: "allow", outlivesOpener: false, createWindow: popupWindowCreator(popupOptions(guest, features)) };
    openAsTab(guest, url, tabKindOf(kind), kind === "background-tab" || kind === "foreground-tab", !!postBody);
    return { action: "deny" };
  });
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) forgetBlocked(contents);
  });
}

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  handleOpen(contents);
});

definePageCall("openBlockedPopup", (guest, args) => openBlocked(guest, typeof args.id === "string" ? args.id : "", args.always === true));
