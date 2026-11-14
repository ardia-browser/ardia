import { app, clipboard, Menu, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents, type WebFrameMain } from "electron";
import { count } from "../counts";
import { isBackground } from "../paths";
import { searchEngineName } from "../services/search";
import { guestOf, tell, windowOf, type Guest } from "./guests";
import { savePage } from "./pageCalls";
import { isPrivateProfile } from "./partitions";
import { printPage } from "./printing";
import { linkToHighlight, selectionLabel } from "./contextMenuText";

type Item = MenuItemConstructorOptions;
type MediaToggle = "loop" | "controls" | "pictureInPicture";

const MEDIA_TOGGLE = (src: string, toggle: MediaToggle) => `(async () => {
  const src = ${JSON.stringify(src)};
  const media = [...document.querySelectorAll("video, audio")].find((m) => m.currentSrc === src || m.src === src);
  if (!media) return false;
  if (${JSON.stringify(toggle)} === "loop") media.loop = !media.loop;
  else if (${JSON.stringify(toggle)} === "controls") media.controls = !media.controls;
  else if (document.pictureInPictureElement === media) await document.exitPictureInPicture();
  else await media.requestPictureInPicture();
  return true;
})()`;

function toggleMedia(frame: WebFrameMain | null | undefined, contents: WebContents, src: string, toggle: MediaToggle) {
  const target = frame && !frame.isDestroyed() ? frame : contents.mainFrame;
  void target.executeJavaScript(MEDIA_TOGGLE(src, toggle), true).catch(() => false);
}

const openLink = (guest: Guest, url: string, disposition: string) =>
  tell(guest, "openWindow", { url, disposition, userGesture: true, fromClick: false, postBody: false });

const viewSource = (url: string) => (url.startsWith("view-source:") ? url : `view-source:${url}`);

function sectioned(sections: Item[][]): Item[] {
  const items: Item[] = [];
  for (const section of sections) {
    if (!section.length) continue;
    if (items.length) items.push({ type: "separator" });
    items.push(...section);
  }
  return items;
}

function linkItems(guest: Guest, params: ContextMenuParams): Item[][] {
  if (!params.linkURL) return [];
  const url = params.linkURL;
  const inPrivate = isPrivateProfile(guest.profile);
  return [
    [
      { label: "Open Link in New Tab", click: () => openLink(guest, url, "background") },
      { label: "Open Link in New Window", click: () => openLink(guest, url, "window") },
      ...(inPrivate ? [] : [{ label: "Open Link in Incognito Window", click: () => openLink(guest, url, "incognito") }]),
      { label: "Open Link in Split View", click: () => openLink(guest, url, "split") },
    ],
    [
      { label: "Save Link As…", click: () => guest.contents.downloadURL(url) },
      { label: "Copy Link Address", click: () => clipboard.writeText(url) },
      ...(params.linkText.trim() ? [{ label: "Copy Link Text", click: () => clipboard.writeText(params.linkText) }] : []),
    ],
  ];
}

function imageItems(guest: Guest, params: ContextMenuParams): Item[][] {
  const contents = guest.contents;
  if (params.mediaType === "canvas") return [[{ label: "Copy Image", click: () => contents.copyImageAt(params.x, params.y) }]];
  if (params.mediaType !== "image" || !params.srcURL || params.srcURL.startsWith("data:") && params.srcURL.length > 2_000_000) return [];
  const src = params.srcURL;
  return [
    [
      { label: "Open Image in New Tab", click: () => openLink(guest, src, "background") },
      { label: "Save Image As…", click: () => contents.downloadURL(src) },
      { label: "Copy Image", click: () => contents.copyImageAt(params.x, params.y) },
      { label: "Copy Image Address", click: () => clipboard.writeText(src) },
    ],
  ];
}

function mediaItems(guest: Guest, params: ContextMenuParams): Item[][] {
  if ((params.mediaType !== "video" && params.mediaType !== "audio") || !params.srcURL) return [];
  const contents = guest.contents;
  const src = params.srcURL;
  const video = params.mediaType === "video";
  const flags = params.mediaFlags;
  const noun = video ? "Video" : "Audio";
  const loadable = !src.startsWith("blob:") && !src.startsWith("mediasource:");
  const controls: Item[] = [
    { label: "Loop", type: "checkbox", checked: flags.isLooping, enabled: flags.canLoop !== false, click: () => toggleMedia(params.frame, contents, src, "loop") },
    { label: "Show Controls", type: "checkbox", checked: flags.isControlsVisible, enabled: flags.canToggleControls !== false, click: () => toggleMedia(params.frame, contents, src, "controls") },
  ];
  if (video && flags.canShowPictureInPicture)
    controls.push({ label: "Picture in Picture", type: "checkbox", checked: flags.isShowingPictureInPicture, click: () => toggleMedia(params.frame, contents, src, "pictureInPicture") });
  return [
    controls,
    [
      { label: `Open ${noun} in New Tab`, enabled: loadable, click: () => openLink(guest, src, "background") },
      { label: `Save ${noun} As…`, enabled: loadable && flags.canSave !== false, click: () => contents.downloadURL(src) },
      { label: `Copy ${noun} Address`, enabled: loadable, click: () => clipboard.writeText(src) },
    ],
  ];
}

function selectionItems(guest: Guest, params: ContextMenuParams): Item[][] {
  if (params.isEditable || !params.selectionText.trim()) return [];
  const text = params.selectionText;
  const highlight = params.frame && params.frame !== guest.contents.mainFrame ? null : linkToHighlight(params.pageURL, text);
  return [
    [
      { label: "Copy", role: "copy" },
      ...(highlight ? [{ label: "Copy Link to Highlight", click: () => clipboard.writeText(highlight) }] : []),
      { label: `Search ${searchEngineName()} for “${selectionLabel(text)}”`, click: () => tell(guest, "command", { command: "search", text, modifiers: {} }) },
      { label: "Print…", click: () => void printPage(guest) },
    ],
  ];
}

function editableItems(guest: Guest, params: ContextMenuParams): Item[][] {
  if (!params.isEditable) return [];
  const contents = guest.contents;
  const flags = params.editFlags;
  const spelling: Item[] = params.misspelledWord
    ? [
        ...(params.dictionarySuggestions.length
          ? params.dictionarySuggestions.map((word): Item => ({ label: word, click: () => contents.replaceMisspelling(word) }))
          : [{ label: "No Spelling Suggestions", enabled: false }]),
        { label: "Add to Dictionary", click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
      ]
    : [];
  return [
    spelling,
    [
      { label: "Undo", role: "undo", enabled: flags.canUndo },
      { label: "Redo", role: "redo", enabled: flags.canRedo },
    ],
    [
      { label: "Cut", role: "cut", enabled: flags.canCut },
      { label: "Copy", role: "copy", enabled: flags.canCopy },
      { label: "Paste", role: "paste", enabled: flags.canPaste },
      { label: "Paste and Match Style", role: "pasteAndMatchStyle", enabled: flags.canPaste },
      { label: "Select All", role: "selectAll", enabled: flags.canSelectAll },
    ],
  ];
}

function pageItems(guest: Guest, params: ContextMenuParams): Item[][] {
  const onPage = !params.linkURL && !params.isEditable && !params.selectionText.trim() && params.mediaType === "none";
  if (!onPage) return [];
  const contents = guest.contents;
  const history = contents.navigationHistory;
  return [
    [
      { label: "Back", enabled: history.canGoBack(), click: () => history.goBack() },
      { label: "Forward", enabled: history.canGoForward(), click: () => history.goForward() },
      { label: "Reload", click: () => contents.reload() },
    ],
    [
      { label: "Save As…", click: () => void savePage(guest).catch(() => {}) },
      { label: "Print…", click: () => void printPage(guest) },
    ],
  ];
}

function developerItems(guest: Guest, params: ContextMenuParams): Item[][] {
  const contents = guest.contents;
  const onPage = !params.linkURL && !params.isEditable && !params.selectionText.trim() && params.mediaType === "none";
  const subframe = params.frameURL && params.frame && params.frame !== contents.mainFrame ? params.frameURL : null;
  return [
    [
      ...(onPage ? [{ label: "View Page Source", click: () => openLink(guest, viewSource(contents.getURL()), "foreground") }] : []),
      ...(onPage && subframe ? [{ label: "View Frame Source", click: () => openLink(guest, viewSource(subframe), "foreground") }] : []),
      { label: "Inspect", click: () => contents.inspectElement(params.x, params.y) },
    ],
  ];
}

export function pageMenu(guest: Guest, params: ContextMenuParams): Item[] {
  return sectioned([
    ...pageItems(guest, params),
    ...linkItems(guest, params),
    ...imageItems(guest, params),
    ...mediaItems(guest, params),
    ...selectionItems(guest, params),
    ...editableItems(guest, params),
    ...developerItems(guest, params),
  ]);
}

const labelsOf = (items: Item[]): string => items.filter((item) => item.type !== "separator").map((item) => item.label).join(" | ");

function showPageMenu(contents: WebContents, params: ContextMenuParams) {
  const guest = guestOf(contents);
  if (!guest) return;
  const items = pageMenu(guest, params);
  count("page_context_menus");
  if (isBackground()) {
    console.info(`[ardia linux] page context menu: ${labelsOf(items)}`);
    return;
  }
  const window = windowOf(guest);
  Menu.buildFromTemplate(items).popup(window ? { window } : {});
}

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  contents.on("context-menu", (_event, params) => showPageMenu(contents, params));
});
