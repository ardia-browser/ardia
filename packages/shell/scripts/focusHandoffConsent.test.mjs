import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

function methodBody(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) return undefined;
  const open = start + signature.length - 1;
  let depth = 0;
  for (let at = open; at < source.length; at++) {
    if (source[at] === "{") depth++;
    if (source[at] === "}" && --depth === 0) return source.slice(open + 1, at);
  }
  return undefined;
}

test("every focus hand-off outcome is counted under the consent epoch its hand-off began in", () => {
  const source = read("../ios/FocusHandoff.swift");
  const calls = source.match(/outcomes\.(?:add|delivered)\(.*\)$/gm) ?? [];
  assert.ok(calls.length >= 5, `found ${calls.length} outcome calls`);
  for (const call of calls) assert.match(call, /since: /, call);
  assert.match(read("../ios/FocusModule.swift"), /^\s*Self\.setConsentEpochFunction$/m);
});

test("the consent epoch is an opaque string, and outcomes are kept per epoch so JS sends only the current one's and keeps the rest locally", () => {
  const source = read("../ios/FocusHandoff.swift");
  assert.match(source, /func setConsentEpoch\(_ epoch: String\)/);
  assert.match(source, /var epoch = ""/);
  assert.match(source, /func add\(_ outcome: String, _ by: Int = 1, since epoch: String\)/);
  assert.match(source, /counts\[epoch, default: \[:\]\]\[outcome, default: 0\] \+= by/);
  assert.match(source, /func take\(\) -> \[String: \[String: Int\]\]/);
  assert.doesNotMatch(source, /since epoch: Int/);
});

test("one setConsentEpoch call moves ArdiaCore's epoch, the hand-off counts and forgets earlier presses", () => {
  const module = read("../ios/FocusModule.swift");
  const call = methodBody(module, "static func setConsentEpoch(_ epoch: String) {");
  assert.ok(call, "setConsentEpoch takes a String");
  assert.match(call, /ArdiaEvents\.consentEpoch = epoch/);
  assert.match(call, /FocusHandoff\.shared\.setConsentEpoch\(epoch\)/);
  assert.match(call, /PressRelease\.forgetPresses\(\)/);
  const area = read("../ios/ContextMenuArea.swift");
  const forget = area.slice(area.indexOf("static func forgetPresses"));
  assert.match(forget, /^static func forgetPresses\(\) \{\s*pressLock\.lock\(\)\s*presses = \(nil, nil\)\s*pressLock\.unlock\(\)/);
  assert.equal(area.match(/presses = /g)?.length, 2, "only the monitor and forgetPresses write the history");
});
