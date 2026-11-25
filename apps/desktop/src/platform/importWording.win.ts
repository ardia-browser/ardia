import type { UnlockWords } from "./importWording.linux.ts";

export type { UnlockWords };

export const UNLOCK_WORDS: UnlockWords = {
  asksOnce: "Some data is encrypted with a key Windows keeps for your account, so each selected profile is unlocked in turn.",
  asks: (app) => `Some data is encrypted with a key Windows keeps for your account, so ${app} unlocks it to bring it in securely.`,
  firefoxAsks: (source, app) => `Some of ${source}'s data is encrypted, so ${app} unlocks it with your Windows account to bring it in securely.`,
  firefoxCardKey: (source, key, app) => `${source} keeps saved card numbers under “${key}”, protected by your Windows account, and ${app} reads it only for this import.`,
  chromiumDetail: (app, item, source) => `${app} asks Windows for “${item}”: it's the key ${source} encrypts passwords, cookies, cards and open tabs with, kept for your Windows account. Your data stays on this PC.`,
  waiting: "Unlocking...",
  noAnswer: "Windows didn't answer",
  firefoxDenied: (source, retry) => `That isn't ${source}'s primary password, or Windows didn't allow access. ${retry}`,
  denied: (item, retry) => `Windows didn't allow access to ${item}. Sign in to Windows as the account that uses this browser. ${retry}`,
  locked: "Windows couldn't unlock this browser's key for your account. Sign out of Windows and back in, then try again, or skip the encrypted data.",
  firefoxNotFound: (source, key) => `Windows has no “${key}” key for your account, so ${source}'s saved card numbers can't be read. Skip the encrypted data to import the rest.`,
  notFound: (item, source) => `Windows has no ${item} key for your account, so ${source}'s encrypted data can't be read. Skip the encrypted data to import the rest.`,
  unavailable: "Windows couldn't open its encrypted storage. Restart Ardia, then try again, or skip the encrypted data.",
  timeout: (retry) => `Windows didn't answer in time. ${retry}`,
};
