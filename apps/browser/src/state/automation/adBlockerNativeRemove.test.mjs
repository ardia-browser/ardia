import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../../../../packages/ardiacore/ios/ArdiaContentBlocker.mm", import.meta.url), "utf8");

function nativeScript(selector) {
  const start = source.indexOf(`+ (void)${selector}`);
  assert.ok(start >= 0, `${selector} is in ArdiaContentBlocker.mm`);
  const body = source.slice(source.indexOf("NSString *script = @", start), source.indexOf(";\n", source.indexOf("NSString *script = @", start)));
  const literals = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c)));
  return literals.join("");
}

const REMOVE = nativeScript("removeAllowedHost:");

async function removeOnMac(whitelist, host, whitelistDefault = ["chrome-extension-scheme", "moz-extension-scheme"]) {
  const sent = [];
  const script = REMOVE.replace("%@", JSON.stringify(host));
  const removed = await runInNewContext(script, {
    trusted: () => Promise.resolve({ whitelist: [...whitelist], whitelistDefault }),
    send: (message) => (sent.push(message), Promise.resolve()),
  });
  const written = sent.length ? sent[0].whitelist.split("\n") : null;
  return { removed, written, sent };
}

test("the Mac exact-remove takes out only the listed entry, in one write", async () => {
  const { removed, written, sent } = await removeOnMac(["chrome-extension-scheme", "moz-extension-scheme", "example.com", "shop.example.com"], "shop.example.com");
  assert.equal(removed, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].what, "setWhitelist");
  assert.deepEqual(written, ["chrome-extension-scheme", "moz-extension-scheme", "example.com"], "the parent entry stays");
});

test("the Mac exact-remove never touches a default, a broader entry or a host that isn't listed", async () => {
  for (const [whitelist, host] of [
    [["chrome-extension-scheme", "moz-extension-scheme"], "chrome-extension-scheme"],
    [["chrome-extension-scheme", "example.com"], "shop.example.com"],
    [["chrome-extension-scheme", "/^(?:ardia-blocking-off|)/"], "example.com"],
    [["chrome-extension-scheme", "x.chrome-extension-scheme"], "chrome-extension-scheme"],
  ]) {
    const { removed, sent } = await removeOnMac(whitelist, host);
    assert.equal(removed, false, `${host} in ${whitelist}`);
    assert.equal(sent.length, 0, `nothing written for ${host}`);
  }
});
