import { ipcMain, type WebContents } from "electron";
import { defineModule, emit } from "../bridge";
import { acceptsPage } from "../ipcSenders";
import { definePageScript, profileOfContents } from "./guests";
import { loginOrigin, loginsFor, markUsed, neverSave, neverSaves, passwordsEnabled, putLogin } from "./passwords";

const MODULE = "ArdiaLinuxPasswords";
const SUBMISSION_KEPT_MS = 60_000;

export type PasswordPrompt = { state: "save" | "update" | "saved"; origin: string; username: string; passwordLength: number; federation: string; usernames: string[] };
type Submission = { profile: string; origin: string; username: string; password: string; at: number };
type OpenPrompt = Submission & { prompt: PasswordPrompt };

function passwordsPage(ipc: Electron.IpcRenderer) {
  const CHANNEL = "ardia:passwords";
  const TEXT_TYPES = ["text", "email", "tel", "url", ""];
  type Saved = { username: string; password: string };
  let saved: Saved[] | null = null;
  let asking: Promise<Saved[]> | null = null;
  let userTyped = false;
  let submittedAt = 0;

  const shown = (el: HTMLInputElement) => !el.disabled && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const passwordFields = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter(shown);
  const usernameFor = (password: HTMLInputElement): HTMLInputElement | null => {
    const scope: ParentNode = password.form ?? document;
    const inputs = Array.from(scope.querySelectorAll<HTMLInputElement>("input")).filter((el) => shown(el) && TEXT_TYPES.includes(el.type.toLowerCase()));
    const before = inputs.filter((el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
    const named = before.filter((el) => /user|login|mail|account|name|id/i.test(`${el.name} ${el.id} ${el.autocomplete}`));
    return named.at(-1) ?? before.at(-1) ?? null;
  };
  const setValue = (el: HTMLInputElement, value: string) => {
    if (el.value === value) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const logins = () => {
    asking ??= ipc.invoke(`${CHANNEL}:logins`).then((list: Saved[]) => (saved = Array.isArray(list) ? list : []));
    return asking;
  };

  const fill = async () => {
    const fields = passwordFields();
    if (!fields.length || userTyped) return;
    const list = await logins();
    if (!list.length) return;
    for (const password of fields) {
      if (password.value || password.autocomplete === "new-password") continue;
      const username = usernameFor(password);
      const typed = username?.value ?? "";
      const login = (typed ? list.find((entry) => entry.username === typed) : list[0]) ?? null;
      if (!login) continue;
      if (username && !typed) setValue(username, login.username);
      setValue(password, login.password);
    }
  };

  const capture = () => {
    const filledPasswords = passwordFields().filter((el) => el.value);
    if (!filledPasswords.length) return;
    const values = filledPasswords.map((el) => el.value);
    const newPassword = values.length >= 2 && values.at(-1) === values.at(-2);
    const field = newPassword ? filledPasswords.at(-1)! : filledPasswords[0]!;
    const username = usernameFor(filledPasswords[0]!)?.value.trim() ?? "";
    const now = Date.now();
    if (now - submittedAt < 300) return;
    submittedAt = now;
    ipc.send(`${CHANNEL}:submitted`, { username, password: field.value });
    setTimeout(() => {
      if (!passwordFields().some((el) => el.value)) ipc.send(`${CHANNEL}:gone`);
    }, 1500);
  };

  document.addEventListener("submit", capture, true);
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target.closest('button, input[type="submit"], input[type="button"], [role="button"]') : null;
      if (target && passwordFields().some((el) => el.value)) capture();
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      const el = event.target;
      if (!(el instanceof HTMLInputElement)) return;
      if (event.key === "Enter") capture();
      else if (event.isTrusted && el.type === "password") userTyped = true;
    },
    true,
  );
  document.addEventListener(
    "change",
    (event) => {
      const el = event.target;
      if (!(el instanceof HTMLInputElement) || el.type === "password" || !saved?.length) return;
      const login = saved.find((entry) => entry.username === el.value);
      if (!login) return;
      for (const password of passwordFields()) if (usernameFor(password) === el && !password.value) setValue(password, login.password);
    },
    true,
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void fill();
    }, 250);
  };
  const start = () => {
    void fill();
    new MutationObserver(later).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["type", "style", "class", "hidden"] });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

definePageScript("ardia-passwords", passwordsPage);

const submissions = new Map<number, Submission>();
const prompts = new Map<number, OpenPrompt>();
const watched = new WeakSet<WebContents>();

function promptFor(submission: Submission): PasswordPrompt | null {
  if (!passwordsEnabled(submission.profile) || neverSaves(submission.profile, submission.origin)) return null;
  const known = loginsFor(submission.profile, submission.origin);
  const same = known.find((login) => login.username === submission.username);
  if (same?.password === submission.password) {
    markUsed(submission.profile, submission.origin, submission.username);
    return null;
  }
  return {
    state: same ? "update" : "save",
    origin: submission.origin,
    username: submission.username,
    passwordLength: submission.password.length,
    federation: "",
    usernames: known.map((login) => login.username),
  };
}

function offer(contents: WebContents) {
  const submission = submissions.get(contents.id);
  submissions.delete(contents.id);
  if (!submission || Date.now() - submission.at > SUBMISSION_KEPT_MS) return;
  const prompt = promptFor(submission);
  if (!prompt) return;
  prompts.set(contents.id, { ...submission, prompt });
  emit(MODULE, "prompt", { webContentsId: contents.id, prompt });
}

function watch(contents: WebContents) {
  if (watched.has(contents)) return;
  watched.add(contents);
  const navigated = () => offer(contents);
  contents.on("did-navigate", navigated);
  contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
    if (isMainFrame) navigated();
  });
  contents.once("destroyed", () => {
    submissions.delete(contents.id);
    prompts.delete(contents.id);
  });
}

const senderOrigin = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
  const frame = event.senderFrame;
  return frame ? loginOrigin(frame.url) : null;
};

ipcMain.handle("ardia:passwords:logins", (event) => {
  if (!acceptsPage(event, "ardia:passwords:logins")) return [];
  const profile = profileOfContents(event.sender);
  const origin = senderOrigin(event);
  if (profile === null || !origin || !passwordsEnabled(profile)) return [];
  return loginsFor(profile, origin).map((login) => ({ username: login.username, password: login.password }));
});

ipcMain.on("ardia:passwords:submitted", (event, submitted: { username?: unknown; password?: unknown }) => {
  if (!acceptsPage(event, "ardia:passwords:submitted")) return;
  const profile = profileOfContents(event.sender);
  const origin = senderOrigin(event);
  if (profile === null || !origin || typeof submitted?.password !== "string" || !submitted.password) return;
  watch(event.sender);
  submissions.set(event.sender.id, {
    profile,
    origin,
    username: typeof submitted.username === "string" ? submitted.username : "",
    password: submitted.password,
    at: Date.now(),
  });
});

ipcMain.on("ardia:passwords:gone", (event) => {
  if (acceptsPage(event, "ardia:passwords:gone")) offer(event.sender);
});

export function resolvePasswordPrompt(webContentsId: number, answer: string, edits: { username?: unknown; password?: unknown } = {}): void {
  const open = prompts.get(webContentsId);
  prompts.delete(webContentsId);
  if (!open) return;
  if (answer === "never") return neverSave(open.profile, open.origin);
  if (answer !== "save" && answer !== "update") return;
  const username = typeof edits.username === "string" ? edits.username : open.username;
  const password = typeof edits.password === "string" && edits.password ? edits.password : open.password;
  putLogin(open.profile, open.origin, username, password, true);
}

defineModule(MODULE, {
  async: {
    resolvePrompt: (webContentsId: number, answer: string, editsJson: string | null) => {
      resolvePasswordPrompt(webContentsId, answer, editsJson ? (JSON.parse(editsJson) as Record<string, unknown>) : {});
      return null;
    },
    openPrompt: (webContentsId: number) => prompts.get(webContentsId)?.prompt ?? null,
  },
});
