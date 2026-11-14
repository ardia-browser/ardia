import { app, dialog, type BrowserWindow, type MessageBoxOptions, type WebContents } from "electron";
import { defineModule } from "../bridge";
import { count } from "../counts";
import { note } from "../log";
import { isBackground } from "../paths";
import { guardQuitWith } from "../quit";
import { appWindow } from "../windows";
import { allGuests, guestOf, PAGES_MODULE, windowOf, type Guest } from "./guests";

const LEAVE = 0;
const QUIT = 0;
const CLOSE = 0;
const CHECK_DEADLINE_MS = 1000;

const WANTS_TO_STAY = `(() => {
  if (!navigator.userActivation || !navigator.userActivation.hasBeenActive) return false;
  let stays = false;
  const event = new Event("beforeunload", { cancelable: true });
  Object.defineProperty(event, "returnValue", {
    configurable: true,
    get: () => "",
    set: (value) => { if (value !== undefined && value !== null && value !== true) stays = true; },
  });
  const own = window.onbeforeunload;
  if (typeof own === "function")
    window.onbeforeunload = function (e) {
      const answer = own.call(this, e);
      if (answer !== undefined && answer !== null && answer !== true) stays = true;
      return answer;
    };
  try {
    window.dispatchEvent(event);
  } finally {
    if (typeof own === "function") window.onbeforeunload = own;
  }
  return stays || event.defaultPrevented;
})()`;

const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

export function askToLeave(contents: WebContents): boolean {
  const site = hostOf(contents.getURL());
  if (isBackground()) {
    note("pages", `${site} asked before leaving; a background instance leaves`);
    return true;
  }
  const guest = guestOf(contents);
  const parent = guest ? windowOf(guest) : null;
  const options = {
    type: "question" as const,
    title: "Leave site?",
    message: "Leave site?",
    detail: "Changes you made may not be saved.",
    buttons: ["Leave", "Cancel"],
    defaultId: LEAVE,
    cancelId: 1,
    noLink: true,
  };
  count("leave_site_asked");
  const answer = parent && !parent.isDestroyed() ? dialog.showMessageBoxSync(parent, options) : dialog.showMessageBoxSync(options);
  if (answer !== LEAVE) count("leave_site_stayed");
  return answer === LEAVE;
}

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  contents.on("will-prevent-unload", (event) => {
    if (askToLeave(contents)) event.preventDefault();
  });
});

function wantsToStay(guest: Guest): Promise<boolean> {
  if (guest.contents.isDestroyed()) return Promise.resolve(false);
  const deadline = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CHECK_DEADLINE_MS));
  const asked = guest.contents.executeJavaScript(WANTS_TO_STAY, false).then((answer) => answer === true, () => false);
  return Promise.race([asked, deadline]);
}

async function sitesWithUnsavedWork(guests: Guest[]): Promise<{ sites: string[]; first: Guest } | null> {
  const answers = await Promise.all(guests.map(wantsToStay));
  const staying = guests.filter((_guest, index) => answers[index]);
  if (!staying.length) return null;
  return { sites: [...new Set(staying.map((guest) => hostOf(guest.contents.getURL())))], first: staying[0]! };
}

const unsavedDetail = (sites: string[]) =>
  sites.length === 1 ? `Changes you made on ${sites[0]} may not be saved.` : `Changes you made on ${sites.length} sites may not be saved.`;

async function askOver(parent: BrowserWindow | null | undefined, options: MessageBoxOptions): Promise<number> {
  const { response } = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response;
}

async function mayQuit(): Promise<boolean> {
  const unsaved = await sitesWithUnsavedWork(allGuests());
  if (!unsaved) return true;
  if (isBackground()) {
    note("pages", `quitting with changes that may not be saved on ${unsaved.sites.join(", ")}; a background instance quits`);
    return true;
  }
  count("quit_unsaved_asked");
  const response = await askOver(windowOf(unsaved.first), {
    type: "question",
    title: "Quit Ardia?",
    message: "Quit Ardia?",
    detail: unsavedDetail(unsaved.sites),
    buttons: ["Quit", "Cancel"],
    defaultId: QUIT,
    cancelId: 1,
    noLink: true,
  });
  if (response !== QUIT) count("quit_unsaved_stayed");
  return response === QUIT;
}

const closingWindows = new Map<string, Promise<boolean>>();

async function askBeforeClosing(windowId: string, tabIds: string[]): Promise<boolean> {
  const closing = new Set(tabIds);
  const unsaved = await sitesWithUnsavedWork(allGuests().filter((guest) => closing.has(guest.tabId)));
  if (!unsaved) return true;
  if (isBackground()) {
    note("pages", `closing a window with changes that may not be saved on ${unsaved.sites.join(", ")}; a background instance closes it`);
    return true;
  }
  count("window_close_unsaved_asked");
  const response = await askOver(appWindow(windowId) ?? windowOf(unsaved.first), {
    type: "question",
    title: "Leave site?",
    message: unsaved.sites.length === 1 ? `Leave ${unsaved.sites[0]}?` : "Leave these sites?",
    detail: unsavedDetail(unsaved.sites),
    buttons: ["Close Window", "Cancel"],
    defaultId: CLOSE,
    cancelId: 1,
    noLink: true,
  });
  if (response !== CLOSE) count("window_close_unsaved_stayed");
  return response === CLOSE;
}

function mayCloseWindow(windowId: string, tabIds: string[]): Promise<boolean> {
  const asking = closingWindows.get(windowId);
  if (asking) return asking.then(() => false);
  const answer = askBeforeClosing(windowId, Array.isArray(tabIds) ? tabIds.filter((id) => typeof id === "string") : []).catch(() => true);
  closingWindows.set(windowId, answer);
  void answer.finally(() => closingWindows.delete(windowId));
  return answer;
}

guardQuitWith(mayQuit);

defineModule(PAGES_MODULE, {
  async: { mayCloseWindow: (windowId: string, tabIds: string[]) => mayCloseWindow(windowId, tabIds) },
});
