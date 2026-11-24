import assert from "node:assert/strict";
import { test } from "node:test";
const { controlLine, controlLineText, parseControlCaller } = await import("./controlCaller.ts");

test("a caller's name is display text: invisible and control characters go, spaces fold, 40 characters at most", () => {
  assert.deepEqual(parseControlCaller({ name: "  T3\u0000 Code\u200b\n(Nightly)\u202e ", app: "/Applications/T3 Code (Nightly).app" }), {
    name: "T3 Code (Nightly)",
    app: "/Applications/T3 Code (Nightly).app",
  });
  assert.equal(parseControlCaller({ name: "x".repeat(100) }).name, "x".repeat(40));
  assert.equal(parseControlCaller({ name: "🙂".repeat(41) }).name, "🙂".repeat(40));
  assert.equal(parseControlCaller({ name: "\u200b\n " }), null);
  assert.equal(parseControlCaller({ name: 7 }), null);
  assert.equal(parseControlCaller("Claude Code"), null);
  assert.equal(parseControlCaller(null), null);
});

test("only an absolute, outermost .app bundle path is kept for the icon", () => {
  const app = (path) => parseControlCaller({ name: "A", app: path }).app;
  assert.equal(app("/Applications/Ghostty.app"), "/Applications/Ghostty.app");
  assert.equal(app("Applications/Ghostty.app"), null);
  assert.equal(app("/Applications/Code.app/Contents/Frameworks/Code Helper.app"), null);
  assert.equal(app("/Applications/../Users/me/Evil.app"), null);
  assert.equal(app("/etc/passwd"), null);
  assert.equal(app(`/${"a".repeat(1100)}.app`), null);
  assert.equal(app(undefined), null);
});

test("no caller reads as a program, and a named one by its own name", () => {
  assert.deepEqual(controlLine(null), { lead: "A program", name: "", rest: " is controlling Ardia" });
  assert.equal(controlLineText(controlLine(null)), "A program is controlling Ardia");
  assert.equal(controlLineText(controlLine({ name: "ardia", app: null })), "ardia is controlling Ardia");
  assert.deepEqual(controlLine({ name: "Codex", app: null }), { lead: "", name: "Codex", rest: " is controlling Ardia" });
});
