import { powerMonitor } from "electron";
import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname } from "node:path";
import { userInfo } from "node:os";
import { count } from "./counts";
import { testValue } from "./launch";
import { note } from "./log";
import { windowPrompt } from "./ownerPrompt";

export type OwnerPrompt = {
  answer(): Promise<Uint8Array | null>;
  refuse(message: string, retryInMs: number): Promise<void>;
  focus(): void;
  close(): void;
};

export type OwnerPromptUI = {
  ask(reason: string, retryInMs: number): Promise<OwnerPrompt>;
  tellUnavailable(reason: string): Promise<void>;
};

const PASSWORD_HELPERS = ["/usr/sbin/unix_chkpwd", "/sbin/unix_chkpwd", "/usr/bin/unix_chkpwd", "/run/wrappers/bin/unix_chkpwd"];
const HELPER_DEADLINE_MS = 15_000;
const WRONG_PASSWORD_EXIT = 7;
const MAX_PASSWORD_BYTES = 512;
const GRANT_REUSE_MS = 60_000;
const RETRY_DELAYS_MS = [0, 0, 2_000, 5_000, 30_000, 60_000];

export type HelperVerdict = "match" | "mismatch" | "failed";

let grantedAt = 0;
let asking: Promise<boolean> | null = null;
let askingPrompt: OwnerPrompt | null = null;
let promptUI: OwnerPromptUI = windowPrompt;
let wrongPasswords = 0;
let retryAt = 0;

const retryInMs = () => Math.max(0, retryAt - Date.now());

function noteWrongPassword() {
  wrongPasswords++;
  retryAt = Date.now() + RETRY_DELAYS_MS[Math.min(wrongPasswords, RETRY_DELAYS_MS.length) - 1]!;
}

function noteRightPassword() {
  wrongPasswords = 0;
  retryAt = 0;
}

export const presentOwnerPromptsWith = (ui: OwnerPromptUI): void => {
  promptUI = ui;
};

const awayListeners: (() => void)[] = [];
let watchingForAway = false;

export const revokeOwnerGrant = (): void => {
  grantedAt = 0;
};

export const whenOwnerAway = (listener: () => void): void => void awayListeners.push(listener);

let awayGeneration = 0;
const awayWaiters = new Set<() => void>();

export function ownerWentAway(): void {
  awayGeneration++;
  revokeOwnerGrant();
  for (const wake of [...awayWaiters]) wake();
  for (const listener of awayListeners) listener();
}

export function ownerPresence(): () => boolean {
  const generation = awayGeneration;
  return () => generation === awayGeneration;
}

function untilAway(): { away: Promise<null>; stop(): void } {
  let wake: () => void = () => undefined;
  const away = new Promise<null>((resolve) => {
    wake = () => resolve(null);
  });
  awayWaiters.add(wake);
  return { away, stop: () => void awayWaiters.delete(wake) };
}

async function answerUnlessAway(prompt: OwnerPrompt, away: Promise<null>): Promise<Uint8Array | null> {
  const answer = prompt.answer();
  const first = await Promise.race([answer, away]);
  if (first === null) void answer.then((late) => late?.fill(0), () => undefined);
  return first;
}

function watchForAway() {
  if (watchingForAway) return;
  watchingForAway = true;
  powerMonitor.on("lock-screen", ownerWentAway);
  powerMonitor.on("suspend", ownerWentAway);
}

const writableByOthers = (stats: Stats) => (stats.mode & 0o022) !== 0;

export function trustedPasswordHelper(path: string, stat: (path: string) => Stats = statSync): string | null {
  try {
    const real = realpathSync(path);
    const file = stat(real);
    if (!file.isFile() || file.uid !== 0 || writableByOthers(file) || (file.mode & 0o111) === 0) return null;
    for (let folder = dirname(real); ; folder = dirname(folder)) {
      const stats = stat(folder);
      if (stats.uid !== 0 || writableByOthers(stats)) return null;
      if (folder === dirname(folder)) return real;
    }
  } catch {
    return null;
  }
}

function passwordHelper(): string | null {
  const testHelper = testValue("passwordHelper");
  if (testHelper !== undefined) return existsSync(testHelper) ? testHelper : null;
  for (const path of PASSWORD_HELPERS) {
    const trusted = trustedPasswordHelper(path);
    if (trusted) return trusted;
  }
  return null;
}

export function runPasswordHelper(helper: string, password: Uint8Array, deadlineMs = HELPER_DEADLINE_MS): Promise<HelperVerdict> {
  const secret = Buffer.alloc(password.length + 1);
  secret.set(password);
  password.fill(0);
  const wipe = () => void secret.fill(0);
  return new Promise((resolve) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (verdict: HelperVerdict) => {
      wipe();
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(verdict);
    };
    try {
      const child = spawn(helper, [userInfo().username, "nonull"], { stdio: ["pipe", "ignore", "ignore"] });
      deadline = setTimeout(() => {
        child.kill("SIGKILL");
        finish("failed");
      }, deadlineMs);
      child.once("error", () => finish("failed"));
      child.once("exit", (code) => finish(code === 0 ? "match" : code === WRONG_PASSWORD_EXIT ? "mismatch" : "failed"));
      child.stdin.on("error", wipe);
      child.stdin.end(secret, wipe);
    } catch {
      finish("failed");
    }
  });
}

function unusablePassword(password: Uint8Array): string | null {
  if (password.length > MAX_PASSWORD_BYTES) return "That password is too long to check.";
  if (password.includes(0)) return "That password can't be checked.";
  return null;
}

async function checkAnswer(prompt: OwnerPrompt, helper: string, password: Uint8Array): Promise<boolean> {
  const waiting = retryInMs();
  if (waiting > 0) {
    count("owner_check_throttled");
    await prompt.refuse("", waiting);
    return false;
  }
  const unusable = unusablePassword(password);
  if (unusable) {
    await prompt.refuse(unusable, 0);
    return false;
  }
  const verdict = await runPasswordHelper(helper, password);
  if (verdict === "match") {
    noteRightPassword();
    return true;
  }
  if (verdict === "failed") {
    count("owner_check_helper_failures");
    await prompt.refuse("Ardia couldn't check the password.", 0);
    return false;
  }
  count("owner_check_wrong_passwords");
  noteWrongPassword();
  await prompt.refuse("Wrong password.", retryInMs());
  return false;
}

async function askForPassword(helper: string, reason: string, present: () => boolean): Promise<boolean> {
  const { away, stop } = untilAway();
  try {
    const prompt = await promptUI.ask(reason, retryInMs());
    askingPrompt = prompt;
    try {
      while (present()) {
        const password = await answerUnlessAway(prompt, away);
        if (password === null) return false;
        try {
          if (await checkAnswer(prompt, helper, password)) return present();
        } finally {
          password.fill(0);
        }
      }
      return false;
    } finally {
      askingPrompt = null;
      prompt.close();
    }
  } finally {
    stop();
  }
}

async function check(reason: string, present: () => boolean): Promise<boolean> {
  const answer = testValue("reauth");
  if (answer !== undefined) {
    note("owner", `device owner check (${reason}) in a test instance: ${answer === "denied" ? "denied" : "granted"}`);
    return answer !== "denied";
  }
  const helper = passwordHelper();
  if (!helper) {
    count("owner_check_unavailable");
    note("owner", `device owner check (${reason}): no trusted unix_chkpwd on this system, so nothing can check the login password; denied`);
    await promptUI.tellUnavailable(reason);
    return false;
  }
  count("owner_check_asked");
  const granted = await askForPassword(helper, reason, present);
  count(granted ? "owner_check_granted" : "owner_check_cancelled");
  return granted;
}

export function confirmDeviceOwner(reason: string): Promise<boolean> {
  if (Date.now() - grantedAt < GRANT_REUSE_MS) return Promise.resolve(true);
  if (asking) {
    askingPrompt?.focus();
    return asking;
  }
  watchForAway();
  const present = ownerPresence();
  asking = check(reason, present)
    .catch(() => false)
    .then((granted) => {
      if (!granted || !present()) return false;
      grantedAt = Date.now();
      return true;
    })
    .finally(() => {
      asking = null;
    });
  return asking;
}
