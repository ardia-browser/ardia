import { app, clipboard, Menu, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from "electron";
import { isBackground } from "../paths";
import { guestOf, tell, windowOf, type Guest } from "./guests";
import { definePageCall, savePage } from "./pageCalls";
import { printPage } from "./printing";
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

function menuFor(guest: Guest, params: ContextMenuParams): MenuItemConstructorOptions[] {
  const contents = guest.contents;
  const history = contents.navigationHistory;
  const items: MenuItemConstructorOptions[] = [];
  const section = (more: MenuItemConstructorOptions[]) => {
    if (!more.length) return;
    if (items.length) items.push({ type: "separator" });
    items.push(...more);
  };
  if (params.linkURL) {
    section([
      { label: "Open Link in New Tab", click: () => openAsTab(guest, params.linkURL, "background", false, false) },
      { label: "Open Link in New Window", click: () => openAsTab(guest, params.linkURL, "window", false, false) },
      { label: "Copy Link Address", click: () => clipboard.writeText(params.linkURL) },
    ]);
  }
  if (params.mediaType === "image" && params.srcURL) {
    section([
      { label: "Open Image in New Tab", click: () => openAsTab(guest, params.srcURL, "background", false, false) },
      { label: "Save Image As…", click: () => contents.downloadURL(params.srcURL) },
      { label: "Copy Image", click: () => contents.copyImageAt(params.x, params.y) },
      { label: "Copy Image Address", click: () => clipboard.writeText(params.srcURL) },
    ]);
  }
  if ((params.mediaType === "video" || params.mediaType === "audio") && params.srcURL) {
    section([
      { label: params.mediaType === "video" ? "Open Video in New Tab" : "Open Audio in New Tab", click: () => openAsTab(guest, params.srcURL, "background", false, false) },
      { label: params.mediaType === "video" ? "Save Video As…" : "Save Audio As…", click: () => contents.downloadURL(params.srcURL) },
      { label: params.mediaType === "video" ? "Copy Video Address" : "Copy Audio Address", click: () => clipboard.writeText(params.srcURL) },
    ]);
  }
  if (params.isEditable) {
    const spelling = params.dictionarySuggestions.map((word): MenuItemConstructorOptions => ({ label: word, click: () => contents.replaceMisspelling(word) }));
    section(spelling);
    section([
      { label: "Undo", role: "undo", enabled: params.editFlags.canUndo },
      { label: "Redo", role: "redo", enabled: params.editFlags.canRedo },
    ]);
    section([
      { label: "Cut", role: "cut", enabled: params.editFlags.canCut },
      { label: "Copy", role: "copy", enabled: params.editFlags.canCopy },
      { label: "Paste", role: "paste", enabled: params.editFlags.canPaste },
      { label: "Paste and Match Style", role: "pasteAndMatchStyle", enabled: params.editFlags.canPaste },
      { label: "Select All", role: "selectAll", enabled: params.editFlags.canSelectAll },
    ]);
  } else if (params.selectionText) {
    const query = params.selectionText.trim().slice(0, 100);
    section([
      { label: "Copy", role: "copy" },
      { label: `Search for “${query.length > 30 ? `${query.slice(0, 30)}…` : query}”`, click: () => tell(guest, "command", { command: "search", text: params.selectionText }) },
    ]);
  }
  if (!params.linkURL && !params.isEditable && !params.selectionText && params.mediaType === "none") {
    section([
      { label: "Back", enabled: history.canGoBack(), click: () => history.goBack() },
      { label: "Forward", enabled: history.canGoForward(), click: () => history.goForward() },
      { label: "Reload", click: () => contents.reload() },
    ]);
    section([
      { label: "Save Page As…", click: () => void savePage(guest).catch(() => {}) },
      { label: "Print…", click: () => void printPage(guest) },
    ]);
  }
  section([{ label: "Inspect", click: () => contents.inspectElement(params.x, params.y) }]);
  return items;
}

function handleContextMenu(contents: WebContents) {
  contents.on("context-menu", (_event, params) => {
    const guest = guestOf(contents);
    if (!guest) return;
    const menu = Menu.buildFromTemplate(menuFor(guest, params));
    if (isBackground()) {
      console.info(`[ardia linux] page context menu: ${menu.items.filter((item) => item.type !== "separator").map((item) => item.label).join(" | ")}`);
      return;
    }
    const window = windowOf(guest);
    menu.popup(window ? { window } : {});
  });
}

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  handleOpen(contents);
  handleContextMenu(contents);
});

definePageCall("openBlockedPopup", (guest, args) => openBlocked(guest, typeof args.id === "string" ? args.id : "", args.always === true));
