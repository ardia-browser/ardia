import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { asSecret, isSecret, onSecretEscape, reveal, sameSecret, SecretEscapeError, secretsDropped, setSecretEscapeMode, withoutSecrets } from "./secret.ts";

const CANARY = "core-canary-7Hq2pZ";

function inMode<T>(mode: "throw" | "drop", run: () => T): T {
  const previous = setSecretEscapeMode(mode);
  try {
    return run();
  } finally {
    setSecretEscapeMode(previous);
  }
}

test("a secret gives its text only to reveal", () => {
  const secret = asSecret("apiToken", CANARY);
  assert.ok(isSecret(secret));
  assert.equal(secret.kind, "apiToken");
  assert.equal(reveal(secret), CANARY);
  assert.deepEqual(Object.keys(secret), []);
  assert.deepEqual({ ...secret }, {});
  assert.ok(!inspect(secret).includes(CANARY));
  assert.ok(Object.isFrozen(secret));
  assert.equal(isSecret({ kind: "apiToken" }), false);
  assert.equal(isSecret(CANARY), false);
  assert.throws(() => reveal(Object.create(Object.getPrototypeOf(secret))), TypeError);
  assert.throws(() => asSecret("cookie" as never, CANARY), TypeError);
});

test("serializing or printing a secret drops and counts it, or throws when asked to", () => {
  const secret = asSecret("password", CANARY);
  const heard: string[] = [];
  const stop = onSecretEscape((where, kind) => heard.push(`${where}:${kind}`));
  const before = secretsDropped();
  inMode("drop", () => {
    assert.equal(JSON.stringify({ a: 1, secret, list: [secret] }), '{"a":1,"list":[null]}');
    assert.equal(`x ${secret}`, "x <secret>");
    assert.equal(String(secret), "<secret>");
  });
  stop();
  assert.equal(secretsDropped() - before, 4);
  assert.deepEqual(heard, ["json:password", "json:password", "text:password", "text:password"]);
  inMode("throw", () => {
    assert.throws(() => JSON.stringify({ secret }), SecretEscapeError);
    assert.throws(() => `${secret}`, SecretEscapeError);
  });
});

test("withoutSecrets copies plain objects and arrays without their secrets and leaves the input alone", () => {
  const secret = asSecret("oauthToken", CANARY);
  const input = { keep: 1, secret, nested: { secret, ok: "yes" }, list: [secret, 2] };
  const out = inMode("drop", () => withoutSecrets(input, "telemetry"));
  assert.deepEqual(out, { keep: 1, nested: { ok: "yes" }, list: [undefined, 2] });
  assert.equal(input.secret, secret);
  const plain = { a: { b: [1, 2] } };
  assert.equal(withoutSecrets(plain, "telemetry"), plain);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.equal(withoutSecrets(cycle, "telemetry"), cycle);
});

test("two secrets are the same when their kind and text are", () => {
  assert.ok(sameSecret(asSecret("oauthToken", CANARY), asSecret("oauthToken", CANARY)));
  assert.ok(!sameSecret(asSecret("oauthToken", CANARY), asSecret("apiToken", CANARY)));
  assert.ok(!sameSecret(asSecret("oauthToken", CANARY), asSecret("oauthToken", `${CANARY}x`)));
  assert.ok(!sameSecret(null, asSecret("oauthToken", CANARY)));
});
