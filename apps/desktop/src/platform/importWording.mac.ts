import type { UnlockWords } from "./importWording.linux.ts";

export type { UnlockWords };

export const UNLOCK_WORDS: UnlockWords = {
  asksOnce: "Some data is encrypted with a key in your Keychain, so macOS may ask for your login password once for each selected profile.",
  asks: (app) => `Some data is encrypted with a key in your Keychain, so macOS may ask for your login password to bring it securely into ${app}.`,
  firefoxAsks: (source, app) => `Some of ${source}'s data is encrypted, so macOS may ask for your login password to bring it securely into ${app}.`,
  firefoxCardKey: (source, key, app) => `${source} keeps saved card numbers under “${key}” in your Keychain, and macOS may ask whether ${app} can read it.`,
  chromiumDetail: (app, item, source) => `${app} asks your Keychain for “${item}”: it's the key ${source} encrypts passwords, cookies, cards and open tabs with. Choose Allow when macOS asks. Your data stays on this Mac.`,
  waiting: "Waiting for the Keychain...",
  noAnswer: "The Keychain didn't answer",
  firefoxDenied: (source, retry) => `That isn't ${source}'s primary password, or the Keychain didn't allow access. ${retry}`,
  denied: (item, retry) => `The Keychain didn't allow access to ${item}. ${retry}`,
  locked: "Your Keychain is locked. Unlock it, then try again, or skip the encrypted data.",
  firefoxNotFound: (source, key) => `Your Keychain has no “${key}” item, so ${source}'s saved card numbers can't be read. Skip the encrypted data to import the rest.`,
  notFound: (item, source) => `Your Keychain has no ${item} item, so ${source}'s encrypted data can't be read. Skip the encrypted data to import the rest.`,
  unavailable: "The Keychain couldn't be opened. Restart Ardia, then try again, or skip the encrypted data.",
  timeout: (retry) => `The Keychain didn't answer in time. ${retry}`,
};
