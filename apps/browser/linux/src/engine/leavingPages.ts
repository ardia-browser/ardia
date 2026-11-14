import { app, dialog, type WebContents } from "electron";
import { note } from "../log";
import { isBackground } from "../paths";
import { guardQuitWith } from "../quit";
import { allGuests, guestOf, windowOf, type Guest } from "./guests";

const LEAVE = 0;
const QUIT = 0;
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
  const answer = parent && !parent.isDestroyed() ? dialog.showMessageBoxSync(parent, options) : dialog.showMessageBoxSync(options);
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

async function mayQuit(): Promise<boolean> {
  const guests = allGuests();
  const answers = await Promise.all(guests.map(wantsToStay));
  const staying = guests.filter((_guest, index) => answers[index]);
  if (!staying.length) return true;
  const sites = [...new Set(staying.map((guest) => hostOf(guest.contents.getURL())))];
  if (isBackground()) {
    note("pages", `quitting with changes that may not be saved on ${sites.join(", ")}; a background instance quits`);
    return true;
  }
  const parent = windowOf(staying[0]!);
  const options = {
    type: "question" as const,
    title: "Quit Ardia?",
    message: "Quit Ardia?",
    detail: sites.length === 1 ? `Changes you made on ${sites[0]} may not be saved.` : `Changes you made on ${sites.length} sites may not be saved.`,
    buttons: ["Quit", "Cancel"],
    defaultId: QUIT,
    cancelId: 1,
    noLink: true,
  };
  const { response } = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === QUIT;
}

guardQuitWith(mayQuit);
