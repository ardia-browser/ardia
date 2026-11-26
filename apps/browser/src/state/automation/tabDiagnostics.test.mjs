import assert from "node:assert/strict";
import { test } from "node:test";

const { consoleKind, droppedSince, MAX_DIAGNOSTICS_LIMIT, MAX_MESSAGE_LENGTH, REDACTED, redactText, redactUrl, shapeDiagnostics } = await import("./tabDiagnostics.ts");

const log = (seq, level, message, extra = {}) => ({ seq, time: 1000 + seq, level, message, source: "https://a.example/app.js", line: seq, frame: "main", ...extra });
const req = (seq, extra = {}) => ({ seq, time: 1000 + seq, method: "GET", url: "https://a.example/api", status: 200, type: "fetch", frame: "main", durationMs: 4, ...extra });
const read = (console, network, extra = {}) => ({ ok: true, console, network, nextSeq: Math.max(0, ...console.map((e) => e.seq), ...network.map((e) => e.seq)) + 1, clearedBefore: 1, capacity: { console: 200, network: 250 }, ...extra });
const all = { since: 0, kind: "all", onlyErrors: false, limit: 200 };

test("an address keeps its origin and path and loses its user, password, query and fragment", () => {
  assert.equal(redactUrl("https://user:hunter2@a.example/path/page?token=abc&x=1#frag"), "https://a.example/path/page");
  assert.equal(redactUrl("wss://a.example:8443/socket?key=1"), "wss://a.example:8443/socket");
  assert.equal(redactUrl("data:"), "data:");
  assert.equal(redactUrl(""), "");
});

test("credentials in an address are stripped through the last @ of its authority", () => {
  assert.equal(redactUrl("https://alice:p@ssword@example.com/path"), "https://example.com/path");
  assert.equal(redactUrl("https://a@b@c@example.com:8080/x?q=1"), "https://example.com:8080/x");
  assert.equal(redactUrl("https://example.com/users/@alice"), "https://example.com/users/@alice");
  assert.equal(redactText("see https://alice:p@ssword@example.com/path now"), "see https://example.com/path now");
  assert.equal(redactText("GET https://alice:pa(ss)word@example.com/path failed"), "GET https://example.com/path failed");
  assert.equal(redactText("(https://example.com/a) and (see https://example.com/b)"), "(https://example.com/a) and (see https://example.com/b)");
  assert.equal(redactText("mail me@example.com at https://example.com/x"), "mail me@example.com at https://example.com/x");
  assert.equal(redactText("See [https://example.com?x=demo] for details"), "See [https://example.com] for details");
  assert.equal(redactText("https://alice:pa[ss]word@example.com/path"), "https://example.com/path");
  assert.equal(redactText("See [https://[::1]/?x=demo] for details"), "See [https://[::1]/] for details");
  assert.equal(redactText("https://example.com/path[a[b]c]?x=demo"), "https://example.com/path[a[b]c]");
  assert.equal(redactText("read https://en.example.org/wiki/Foo_(bar)?s=1 now"), "read https://en.example.org/wiki/Foo_(bar) now");
  assert.equal(redactText("fetch http://[::1]:8080/a?k=v failed"), "fetch http://[::1]:8080/a failed");
  assert.equal(redactText("(https://example.com),user@example.org"), "(https://example.com),user@example.org");
  assert.equal(redactText("request failed at https://alice:pa(ss)word@example.com/path"), "request failed at https://example.com/path");
  assert.equal(redactText("open https://example.com/a?token=x, then retry."), "open https://example.com/a, then retry.");
  assert.equal(redactText("see https://example.com/path."), "see https://example.com/path.");
  assert.equal(redactText("fetch https://alice:pa,ss@example.org/path failed"), "fetch https://example.org/path failed");
  assert.equal(redactText("fetch https://alice:pa;ss@example.org/path?a=1;b=2 failed"), "fetch https://example.org/path failed");
  assert.equal(redactText("GET https://example.org/x?email=alice,bob@example.org 200"), "GET https://example.org/x 200");
  assert.equal(redactText(`${"x".repeat(980)} https://alice:passw`), `${"x".repeat(980)} https://${REDACTED}`);
  assert.equal(redactText("http://localhost:8080/ok"), "http://localhost:8080/ok");
  const clippedNumeric = shapeDiagnostics(read([log(1, "error", `${"x".repeat(980)} https://alice:1234`, { clipped: true })], []), all);
  assert.equal(clippedNumeric.console[0].message, `${"x".repeat(980)} https://${REDACTED}`);
  const started = performance.now();
  const repeated = "a.".repeat(16384);
  assert.equal(redactText(repeated).length, MAX_MESSAGE_LENGTH);
  assert.ok(performance.now() - started < 500, "URL scanning stays linear on repeated dotted text");
});

test("path segments that look like tokens are redacted, ordinary slugs are kept", () => {
  assert.equal(redactUrl("https://a.example/reset/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08/done"), `https://a.example/reset/${REDACTED}/done`);
  assert.equal(redactUrl("https://a.example/s/aZ3kQ9vLmP2xR7tY8wB4nC6d"), `https://a.example/s/${REDACTED}`);
  assert.equal(redactUrl("https://a.example/api/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig/x"), `https://a.example/api/${REDACTED}/x`);
  assert.equal(redactUrl("https://a.example/blog/how-to-write-a-long-article-title-2026"), "https://a.example/blog/how-to-write-a-long-article-title-2026");
  assert.equal(redactUrl("https://a.example/users/42/settings"), "https://a.example/users/42/settings");
});

test("credentials in console text are redacted, the rest of the message stays readable", () => {
  const cases = [
    ["Authorization: Bearer abc.def-123456789", `Authorization: Bearer ${REDACTED}`],
    ["sent Bearer abcdef123456 to server", `sent Bearer ${REDACTED} to server`],
    ["password=hunter2 failed", `password=${REDACTED} failed`],
    ['{"api_key":"sk_live_51Habc","user":"bo"}', `{"api_key":"${REDACTED}","user":"bo"}`],
    ["session_id: 77abc, retrying", `session_id: ${REDACTED}, retrying`],
    ['password="two words" sent', `password="${REDACTED}" sent`],
    ["token='a b c' x", `token='${REDACTED}' x`],
    ['{"password":"ab\\"cd ef","u":1}', `{"password":"${REDACTED}","u":1}`],
    ['log password="cut off by the engine cap', `log password="${REDACTED}"`],
    ['log password="abc\\', `log password="${REDACTED}"`],
    ['{"token":"ab\\\nc"} after', `{"token":"${REDACTED}"} after`],
    ['{"authToken":"abc","ok":1}', `{"authToken":"${REDACTED}","ok":1}`],
    ["auth_token=xyz123 auth-token: 999", `auth_token=${REDACTED} auth-token: ${REDACTED}`],
    ['{"password":"[redacted]realSecret"}', `{"password":"${REDACTED}"}`],
    ["password=[redacted]secret ok", `password=${REDACTED} ok`],
    ["password=secret=[redacted] ok", `password=${REDACTED} ok`],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl here", `jwt ${REDACTED} here`],
    ["GET https://a.example/cb?code=secret#x 404", "GET https://a.example/cb 404"],
    ["key -----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY----- end", `key ${REDACTED} end`],
    ["Uncaught TypeError: x is not a function", "Uncaught TypeError: x is not a function"],
  ];
  for (const [given, shown] of cases) assert.equal(redactText(given), shown, given);
});

test("every pair of a Cookie or Set-Cookie header is redacted, whatever its name or length", () => {
  assert.equal(redactText("Cookie: theme=dark; login=abc123"), `Cookie: theme=${REDACTED}; login=${REDACTED}`);
  assert.equal(redactText("sent cookie:a=1;b=2"), `sent cookie:a=${REDACTED};b=${REDACTED}`);
  assert.equal(redactText('Set-Cookie: sid="x y"; Path=/; HttpOnly'), `Set-Cookie: sid=${REDACTED}; Path=${REDACTED}; HttpOnly`);
  assert.ok(!redactText("Cookie: theme=dark; login=abc123\nnext line").includes("abc123"));
  assert.equal(redactText("Cookie: x=1\nok line"), `Cookie: x=${REDACTED}\nok line`);
});

test("an explicit Authorization or Proxy-Authorization header loses its whole credential, whatever the scheme", () => {
  assert.equal(redactText("Authorization: Token secretword"), `Authorization: Token ${REDACTED}`);
  assert.equal(redactText('Authorization: Digest username="alice", realm="r", nonce="n0nce", response="deadbeef"'), `Authorization: Digest ${REDACTED}`);
  assert.equal(redactText("Proxy-Authorization: Basic abc"), `Proxy-Authorization: Basic ${REDACTED}`);
  assert.equal(redactText("proxy-authorization: Bearer x\nnext"), `proxy-authorization: Bearer ${REDACTED}\nnext`);
  assert.equal(redactText('{"Authorization":"Token abc def","x":1}'), `{"Authorization":"Token ${REDACTED}","x":1}`);
  assert.equal(redactText("Authorization: opaquevalue"), `Authorization: ${REDACTED}`);
  for (const secret of ["secretword", "alice", "deadbeef", "n0nce", "abc def"]) assert.ok(!redactText(`Authorization: Digest username="${secret}"`).includes(secret), secret);
});

test("short Basic credentials are redacted, ordinary words after an auth scheme are not", () => {
  assert.equal(redactText("Authorization: Basic dTpw"), `Authorization: Basic ${REDACTED}`);
  assert.equal(redactText("Basic YWxhZGRpbjpvcGVuc2VzYW1l"), `Basic ${REDACTED}`);
  assert.equal(redactText("Bearer abc"), `Bearer ${REDACTED}`);
  assert.equal(redactText("Token expired"), "Token expired");
  assert.equal(redactText("Basic idea"), "Basic idea");
  assert.equal(redactText("Digest of the week"), "Digest of the week");
  assert.equal(redactText("Token t0k3n-value"), `Token ${REDACTED}`);
  const opaque = redactText("cache key 4f9a2b7c1d8e3f6a5b0c9d2e7f1a4b8c then");
  assert.equal(opaque, `cache key ${REDACTED} then`);
});

test("a message is capped at its length limit after redaction", () => {
  const shown = redactText("x ".repeat(5000));
  assert.equal(shown.length, MAX_MESSAGE_LENGTH);
  assert.ok(shown.endsWith("…"));
});

test("uncaught exceptions and unhandled rejections are told apart from console errors", () => {
  assert.equal(consoleKind({ level: "error", message: "Uncaught (in promise) Error: boom" }), "rejection");
  assert.equal(consoleKind({ level: "error", message: "Uncaught ReferenceError: y" }), "exception");
  assert.equal(consoleKind({ level: "error", message: "failed to load" }), "console");
  assert.equal(consoleKind({ level: "warning", message: "Uncaught nothing" }), "console");
});

test("console and network entries merge in one sequence and the watermark resumes after the last one", () => {
  const r = read([log(1, "info", "hi"), log(3, "error", "Uncaught (in promise) boom")], [req(2), req(4, { status: 500, failed: true })]);
  const first = shapeDiagnostics(r, all);
  assert.deepEqual([...first.console.map((e) => e.seq), ...first.network.map((e) => e.seq)].sort(), [1, 2, 3, 4]);
  assert.equal(first.nextSeq, 5);
  assert.equal(first.more, false);
  assert.equal(first.console[1].kind, "rejection");
  assert.equal(first.network[1].failed, true);
  const again = shapeDiagnostics({ ...r, console: [], network: [] }, { ...all, since: first.nextSeq });
  assert.equal(again.nextSeq, 5);
  assert.deepEqual([again.console, again.network, again.dropped], [[], [], 0]);
});

test("kind and onlyErrors filter, and the watermark still covers what they skipped", () => {
  const r = read([log(1, "info", "a"), log(2, "warning", "b"), log(5, "debug", "c")], [req(3), req(4, { error: "ERR_NAME_NOT_RESOLVED", failed: true, status: 0 })]);
  const errors = shapeDiagnostics(r, { ...all, onlyErrors: true });
  assert.deepEqual(errors.console.map((e) => e.seq), [2]);
  assert.deepEqual(errors.network.map((e) => e.seq), [4]);
  assert.equal(errors.nextSeq, 6);
  const network = shapeDiagnostics(r, { ...all, kind: "network" });
  assert.deepEqual(network.console, []);
  assert.deepEqual(network.network.map((e) => e.seq), [3, 4]);
  assert.equal(shapeDiagnostics(r, { ...all, kind: "console" }).network.length, 0);
});

test("a limit stops the read at the last entry returned, so nothing is skipped", () => {
  const r = read([1, 2, 3, 4, 5].map((seq) => log(seq, "error", `e${seq}`)), []);
  const page = shapeDiagnostics(r, { ...all, limit: 2 });
  assert.deepEqual(page.console.map((e) => e.seq), [1, 2]);
  assert.equal(page.more, true);
  assert.equal(page.nextSeq, 3);
  const rest = shapeDiagnostics({ ...r, console: r.console.filter((e) => e.seq >= 3) }, { ...all, since: page.nextSeq, limit: 10 });
  assert.deepEqual(rest.console.map((e) => e.seq), [3, 4, 5]);
  assert.equal(rest.nextSeq, 6);
  assert.equal(shapeDiagnostics(r, { ...all, limit: 10_000 }).console.length, 5, "a huge limit is capped, not refused");
  assert.ok(MAX_DIAGNOSTICS_LIMIT <= 500);
});

test("a byte budget that fits fewer rows than the limit moves the watermark only past what was sent", () => {
  const r = read([1, 2, 3].map((seq) => log(seq, "error", `e${seq}`)), []);
  const page = shapeDiagnostics(r, all, (rows) => rows.slice(0, 1));
  assert.equal(page.console.length, 1);
  assert.equal(page.more, true);
  assert.equal(page.nextSeq, 2);
});

test("dropped counts entries the ring overwrote after the watermark, not ones the caller cleared", () => {
  const r = read([log(8, "error", "late"), log(9, "error", "later")], [req(10)], { nextSeq: 11, clearedBefore: 1 });
  assert.equal(droppedSince(r, 0), 7);
  assert.equal(droppedSince(r, 5), 3);
  assert.equal(droppedSince(r, 8), 0);
  assert.equal(droppedSince({ ...r, clearedBefore: 8 }, 0), 0);
  assert.equal(shapeDiagnostics(r, { ...all, since: 5 }).dropped, 3);
  assert.equal(droppedSince(r, 0, 4), 3, "only gaps before the returned watermark count");
  const gappy = read([log(3, "error", "a"), log(9, "error", "b")], [], { nextSeq: 10, clearedBefore: 1 });
  const first = shapeDiagnostics(gappy, { ...all, limit: 1 });
  const second = shapeDiagnostics(gappy, { ...all, since: first.nextSeq, limit: 1 });
  assert.deepEqual([first.nextSeq, first.dropped, second.nextSeq, second.dropped], [4, 2, 10, 5], "paged reads never count a gap twice");
});

test("rows carry only the fields the reply documents, with addresses and messages redacted", () => {
  const r = read([log(1, "error", 'token=abc123 {"authToken":"short"}', { source: "https://a.example/app.js?v=secret", extra: "leak" })], [req(2, { url: "https://u:p@a.example/x?y=1", headers: { cookie: "c" } })]);
  const shaped = shapeDiagnostics(r, all);
  assert.deepEqual(Object.keys(shaped.console[0]).sort(), ["frame", "kind", "level", "line", "message", "seq", "source", "time"]);
  assert.equal(shaped.console[0].message, `token=${REDACTED} {"authToken":"${REDACTED}"}`);
  assert.equal(shaped.console[0].source, "https://a.example/app.js");
  assert.deepEqual(Object.keys(shaped.network[0]).sort(), ["durationMs", "failed", "frame", "method", "seq", "status", "time", "type", "url"]);
  assert.equal(shaped.network[0].url, "https://a.example/x");
});
