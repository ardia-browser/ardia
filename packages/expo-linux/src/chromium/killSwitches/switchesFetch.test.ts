/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { KILL_SWITCHES_URL, nativeSwitchesFetch } from "./switchesFetch";

const original = (async () => new Response("other", { status: 200 })) as typeof fetch;

test("the switches URL is answered by the native call, other URLs by the original fetch", async () => {
  let asked = 0;
  const shimmed = nativeSwitchesFetch(async () => (asked++, { status: 200, body: '{"version":1,"switches":{}}' }), original);
  const response = await shimmed(KILL_SWITCHES_URL, { credentials: "omit", cache: "no-store" });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"version":1,"switches":{}}');
  assert.equal(await (await shimmed("https://example.com/")).text(), "other");
  assert.equal(asked, 1);
});

test("a failed native fetch rejects like fetch, an HTTP error is a response, abort rejects", async () => {
  const failing = nativeSwitchesFetch(async () => ({ status: 0, body: "" }), original);
  await assert.rejects(failing(KILL_SWITCHES_URL), TypeError);
  const missing = nativeSwitchesFetch(async () => ({ status: 404, body: "no" }), original);
  assert.equal((await missing(KILL_SWITCHES_URL)).ok, false);
  const slow = nativeSwitchesFetch(() => new Promise(() => {}), original);
  const abort = new AbortController();
  const pending = slow(KILL_SWITCHES_URL, { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
});
