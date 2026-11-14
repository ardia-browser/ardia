import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { count } from "./counts";
import { testValue } from "./launch";
import { note } from "./log";
import { windowPrompt } from "./ownerPrompt";
import { isBackground } from "./paths";

export type OwnerPrompt = {
  answer(): Promise<string | null>;
  wrongPassword(): Promise<void>;
  focus(): void;
  close(): void;
};

export type OwnerPromptUI = {
  ask(reason: string): Promise<OwnerPrompt>;
};

const PASSWORD_HELPERS = ["/usr/sbin/unix_chkpwd", "/sbin/unix_chkpwd", "/usr/bin/unix_chkpwd"];
const HELPER_DEADLINE_MS = 15_000;
const GRANT_REUSE_MS = 60_000;

let grantedAt = 0;
let asking: Promise<boolean> | null = null;
let askingPrompt: OwnerPrompt | null = null;
let promptUI: OwnerPromptUI = windowPrompt;

export const presentOwnerPromptsWith = (ui: OwnerPromptUI): void => {
  promptUI = ui;
};

export const revokeOwnerGrant = (): void => {
  grantedAt = 0;
};

function passwordHelper(): string | null {
  const testHelper = testValue("passwordHelper");
  if (testHelper !== undefined) return existsSync(testHelper) ? testHelper : null;
  return PASSWORD_HELPERS.find((path) => existsSync(path)) ?? null;
}

function passwordMatches(helper: string, password: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(helper, [userInfo().username, "nonull"], { stdio: ["pipe", "ignore", "ignore"] });
    const deadline = setTimeout(() => child.kill("SIGKILL"), HELPER_DEADLINE_MS);
    child.once("error", () => {
      clearTimeout(deadline);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(deadline);
      resolve(code === 0);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.concat([Buffer.from(password, "utf8"), Buffer.from([0])]));
  });
}

async function askForPassword(helper: string, reason: string): Promise<boolean> {
  const prompt = await promptUI.ask(reason);
  askingPrompt = prompt;
  try {
    for (;;) {
      const password = await prompt.answer();
      if (password === null) return false;
      if (await passwordMatches(helper, password)) return true;
      count("owner_check_wrong_passwords");
      await prompt.wrongPassword();
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
  if (isBackground()) {
    note("owner", `device owner check (${reason}) in a background instance: granted`);
    return true;
  }
  const helper = passwordHelper();
  if (!helper) {
    count("owner_check_unavailable");
    note("owner", `device owner check (${reason}): no unix_chkpwd on this system, so nothing can check the login password; granted`);
    return true;
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
