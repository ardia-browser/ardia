import assert from "node:assert/strict";
import { test } from "node:test";
import { managerStatus } from "./managerStatus.ts";

const servers = [{ id: "us", title: "Bitwarden.com" }, { id: "eu", title: "Bitwarden.eu" }, { id: "self", title: "Self-Hosted", custom: true }];
const bw = (patch = {}) => ({ id: "bitwarden", name: "Bitwarden", title: "Bitwarden", state: "signedOut", install: { command: "brew install bitwarden-cli", update: "brew upgrade bitwarden-cli", url: "" }, signIn: { methods: [], servers }, ...patch });
const words = (p) => {
  const s = managerStatus(p);
  return [s.line, s.tone, s.action, s.command, s.menu];
};

test("each state reads where things stand and offers the one control that moves it on", () => {
  assert.deepEqual(words(bw({ state: "unlocked", account: "sam@example.com" })), ["Connected as sam@example.com", "textSecondary", "none", null, true]);
  assert.deepEqual(words(bw({ state: "unlocked", account: "sam@example.com", server: "eu" })), ["Connected as sam@example.com · Bitwarden.eu", "textSecondary", "none", null, true]);
  assert.deepEqual(words(bw({ state: "unlocked", server: "https://vault.example.com" })), ["Connected · vault.example.com", "textSecondary", "none", null, true]);
  assert.deepEqual(words(bw({ state: "locked", account: "sam@example.com" })), ["Locked · sam@example.com", "textSecondary", "unlock", null, true]);
  assert.deepEqual(words(bw()), ["Not signed in", "textSecondary", "signIn", null, false]);
  assert.deepEqual(words(bw({ needs: { kind: "code" } })), ["Signing in…", "textSecondary", "continue", null, false]);
  assert.deepEqual(words(bw({ state: "notInstalled" })), ["Not installed", "textSecondary", "check", "brew install bitwarden-cli", false]);
});

test("an old CLI shows the native line with the update command, other problems replace the line in amber", () => {
  assert.deepEqual(words(bw({ problem: { code: "cliTooOld", message: "Needs Bitwarden CLI 2024.6.0 or later." } })), ["Needs Bitwarden CLI 2024.6.0 or later.", "warning", "check", "brew upgrade bitwarden-cli", false]);
  assert.deepEqual(words(bw({ state: "unlocked", account: "a@b.c", problem: { code: "offline", message: "Offline." } })), ["Offline.", "warning", "none", null, true]);
  assert.deepEqual(words(bw({ problem: { code: "failed", message: "Couldn't reach the server." } })), ["Couldn't reach the server.", "warning", "signIn", null, false]);
});

test("an unavailable plugin says why: a crash offers Restart only when it can, updating offers nothing, off points at Plugins", () => {
  const down = (reason, canRestart, patch = {}) => words(bw({ state: "unavailable", unavailable: { reason, canRestart }, ...patch }));
  assert.deepEqual(down("crashed", true), ["Quit unexpectedly", "destructive", "restart", null, true]);
  assert.deepEqual(down("crashed", false).slice(0, 3), ["Quit unexpectedly", "destructive", "none"]);
  assert.deepEqual(down("updating", false), ["Updating…", "textSecondary", "none", null, false]);
  assert.deepEqual(down("off", false).slice(0, 3), ["Off", "textSecondary", "turnOn"]);
  assert.deepEqual(down("damaged", false, { problem: { code: "damaged", message: "Its files changed. Remove it and add it again." } }).slice(0, 2), ["Its files changed. Remove it and add it again.", "destructive"]);
  assert.deepEqual(words(bw({ state: "unavailable" })).slice(0, 2), ["Unavailable", "destructive"]);
});
