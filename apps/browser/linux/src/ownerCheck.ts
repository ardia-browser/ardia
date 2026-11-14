import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname } from "node:path";
import { userInfo } from "node:os";
import { count } from "./counts";
import { testValue } from "./launch";
import { note } from "./log";
import { windowPrompt } from "./ownerPrompt";

export type OwnerPrompt = {
  answer(): Promise<string | null>;
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

export const revokeOwnerGrant = (): void => {
  grantedAt = 0;
};

const writableByOthers = (stats: Stats) => (stats.mode & 0o002) !== 0 || ((stats.mode & 0o020) !== 0 && stats.gid !== 0);

export function trustedPasswordHelper(path: string): string | null {
  try {
    const real = realpathSync(path);
    const file = statSync(real);
    if (!file.isFile() || file.uid !== 0 || writableByOthers(file) || (file.mode & 0o111) === 0) return null;
    for (let folder = dirname(real); ; folder = dirname(folder)) {
      const stats = statSync(folder);
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

export function runPasswordHelper(helper: string, password: string, deadlineMs = HELPER_DEADLINE_MS): Promise<HelperVerdict> {
  return new Promise((resolve) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (verdict: HelperVerdict) => {
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
      child.stdin.on("error", () => {});
      child.stdin.end(Buffer.concat([Buffer.from(password, "utf8"), Buffer.from([0])]));
    } catch {
      finish("failed");
    }
  });
}

function unusablePassword(password: string): string | null {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return "That password is too long to check.";
  if (password.includes("\0")) return "That password can't be checked.";
  return null;
}

async function askForPassword(helper: string, reason: string): Promise<boolean> {
  const prompt = await promptUI.ask(reason, retryInMs());
  askingPrompt = prompt;
  try {
    for (;;) {
      const password = await prompt.answer();
      if (password === null) return false;
      const waiting = retryInMs();
      if (waiting > 0) {
        count("owner_check_throttled");
        await prompt.refuse("", waiting);
        continue;
      }
      const unusable = unusablePassword(password);
      if (unusable) {
        await prompt.refuse(unusable, 0);
        continue;
      }
      const verdict = await runPasswordHelper(helper, password);
      if (verdict === "match") {
        noteRightPassword();
        return true;
      }
      if (verdict === "failed") {
        count("owner_check_helper_failures");
        await prompt.refuse("Ardia couldn't check the password.", 0);
        continue;
      }
      count("owner_check_wrong_passwords");
      noteWrongPassword();
      await prompt.refuse("Wrong password.", retryInMs());
    }
  } finally {
    askingPrompt = null;
    prompt.close();
  }
}

async function check(reason: string): Promise<boolean> {
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
  const granted = await askForPassword(helper, reason);
  count(granted ? "owner_check_granted" : "owner_check_cancelled");
  return granted;
}

export function confirmDeviceOwner(reason: string): Promise<boolean> {
  if (Date.now() - grantedAt < GRANT_REUSE_MS) return Promise.resolve(true);
  if (asking) {
    askingPrompt?.focus();
    return asking;
  }
  asking = check(reason)
    .catch(() => false)
    .then((granted) => {
      if (granted) grantedAt = Date.now();
      return granted;
    })
    .finally(() => {
      asking = null;
    });
  return asking;
}
