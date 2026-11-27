import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteOutcome } from "./omnibox.ts";
import { BLOCKED_BACKOFF_MS, carriedValues, createRemoteSuggester, MOST_REMOTE_IN_FLIGHT, PACED_DELAY_MS, PACED_FOR_MS, type RemoteAnswer, type RemoteClock } from "./remoteSuggester.ts";

type Pending = { text: string; signal: AbortSignal; answer: (values: string[]) => void; fail: () => void; refuse: (code: number, retryAfterMs?: number) => void };

function network() {
  const pending: Pending[] = [];
  const fetchRemote = (text: string, signal: AbortSignal) =>
    new Promise<RemoteOutcome>((done) => {
      signal.addEventListener("abort", () => done({ values: [], status: "failed" }));
      pending.push({ text, signal, answer: (values) => done({ values, status: "ok" }), fail: () => done({ values: [], status: "failed" }), refuse: (code, retryAfterMs) => done({ values: [], status: "http", code, retryAfterMs }) });
    });
  return { pending, fetchRemote };
}

const request = <T,>(list: readonly T[], index: number): T => {
  const found = list[index];
  assert.ok(found, `no item ${index}`);
  return found;
};

const settle = () => new Promise<void>((done) => setImmediate(done));

const answersFor = (text: string) => [`${text}a`, `${text}b`, `${text}zz`];

function fakeClock() {
  let now = 0;
  let timers: { at: number; run: () => void; id: number }[] = [];
  let ids = 0;
  const clock: RemoteClock = {
    now: () => now,
    later: (run, ms) => {
      const id = ++ids;
      timers.push({ at: now + ms, run, id });
      return id;
    },
    cancel: (id) => {
      timers = timers.filter((timer) => timer.id !== id);
    },
  };
  const pass = (ms: number) => {
    now += ms;
    const due = timers.filter((timer) => timer.at <= now);
    timers = timers.filter((timer) => timer.at > now);
    for (const timer of due) timer.run();
  };
  return { clock, pass };
}

function typing() {
  const net = network();
  const time = fakeClock();
  const suggester = createRemoteSuggester(net.fetchRemote, time.clock);
  let field = "";
  const shown: { text: string; answer: RemoteAnswer; cached: boolean; field: string }[] = [];
  const type = (text: string, scope = "s") => {
    field = text;
    suggester.ask({ scope, text, remembers: true, current: () => field, show: (answer, cached) => shown.push({ text, answer, cached, field }) });
  };
  return { net, suggester, shown, type, setField: (text: string) => (field = text), pass: time.pass };
}

test("each keystroke asks at once, and an answer for an earlier prefix shows while typing goes on", async () => {
  const { net, shown, type } = typing();
  type("o");
  type("ot");
  type("ott");
  assert.deepEqual(
    net.pending.map((p) => p.text),
    ["o", "ot", "ott"],
  );
  assert.ok(net.pending.every((p) => !p.signal.aborted), "a request for a prefix of what is typed is never thrown away");
  request(net.pending, 0).answer(["otter", "ottawa", "oil"]);
  await settle();
  assert.equal(shown.length, 1);
  assert.equal(request(shown, 0).answer.text, "o");
  assert.equal(request(shown, 0).field, "ott");
  assert.deepEqual(carriedValues(request(shown, 0).answer, "ott"), ["otter", "ottawa"]);
});

test("an older answer never replaces a newer one that already showed", async () => {
  const { net, shown, type } = typing();
  type("w");
  type("we");
  request(net.pending, 1).answer(answersFor("we"));
  await settle();
  request(net.pending, 0).answer(answersFor("w"));
  await settle();
  assert.deepEqual(
    shown.map((s) => s.answer.text),
    ["we"],
  );
});

test("an answer for text the field moved away from is dropped, and its request is cancelled", async () => {
  const { net, shown, type, setField } = typing();
  type("cat");
  setField("dog");
  type("dog");
  assert.equal(request(net.pending, 0).signal.aborted, true);
  request(net.pending, 1).answer(answersFor("dog"));
  await settle();
  assert.deepEqual(
    shown.map((s) => s.answer.text),
    ["dog"],
  );
});

test("backspacing to text already answered shows the remembered answer in the same call, with no request", async () => {
  const { net, shown, type, setField } = typing();
  type("ne");
  request(net.pending, 0).answer(answersFor("ne"));
  await settle();
  type("new");
  setField("ne");
  const asked = net.pending.length;
  type("ne");
  assert.equal(net.pending.length, asked);
  assert.equal(shown.at(-1)?.cached, true);
  assert.equal(shown.at(-1)?.answer.text, "ne");
});

test("a failed request keeps the rows that were showing", async () => {
  const { net, shown, type } = typing();
  type("m");
  request(net.pending, 0).answer(answersFor("m"));
  await settle();
  type("ma");
  request(net.pending, 1).fail();
  await settle();
  assert.deepEqual(
    shown.map((s) => s.answer.text),
    ["m"],
  );
});

test("no more than a few requests fly at once; the oldest gives way", () => {
  const { net, suggester, type } = typing();
  const word = "abcdefgh";
  for (let i = 1; i <= word.length; i++) type(word.slice(0, i));
  assert.equal(suggester.inFlight(), MOST_REMOTE_IN_FLIGHT);
  assert.equal(net.pending.filter((p) => !p.signal.aborted).length, MOST_REMOTE_IN_FLIGHT);
});

test("answers from another scope (Incognito or another engine) are never carried or reused", async () => {
  const { net, suggester, shown, type } = typing();
  type("q", "normal");
  request(net.pending, 0).answer(answersFor("q"));
  await settle();
  assert.equal(suggester.shown("private"), null);
  type("q", "private");
  assert.equal(net.pending.length, 2, "the other scope asks again instead of reusing the answer");
  assert.equal(shown.length, 1);
});

test("reset cancels every request and forgets what was shown", async () => {
  const { net, suggester, shown, type } = typing();
  type("x");
  suggester.reset();
  assert.equal(request(net.pending, 0).signal.aborted, true);
  request(net.pending, 0).answer(answersFor("x"));
  await settle();
  assert.equal(shown.length, 0);
  assert.equal(suggester.shown("s"), null);
});

test("carried values keep only those that still start with the typed text", () => {
  assert.deepEqual(carriedValues({ text: "ot", values: ["Otter", "ottawa", "other"] }, "ott"), ["Otter", "ottawa"]);
  assert.deepEqual(carriedValues({ text: "ot", values: ["otter"] }, "o"), []);
  assert.deepEqual(carriedValues({ text: "ot", values: ["other"] }, "ot"), ["other"]);
  assert.deepEqual(carriedValues(null, "ot"), []);
});

test("clearing the field cancels the requests still flying, so their answers never fill the cache", async () => {
  const { net, suggester, type, setField } = typing();
  type("dormouse");
  setField("");
  suggester.prune("s", "");
  assert.equal(request(net.pending, 0).signal.aborted, true);
  assert.equal(suggester.inFlight(), 0);
  type("dormouse");
  assert.equal(net.pending.length, 2, "retyping asks again instead of showing a cached answer from the cancelled request");
});

test("a remembered answer still cancels the requests it makes obsolete", async () => {
  const { net, suggester, shown, type, setField } = typing();
  type("ne");
  request(net.pending, 0).answer(answersFor("ne"));
  await settle();
  type("new");
  setField("ne");
  type("ne");
  assert.equal(shown.at(-1)?.cached, true);
  assert.equal(request(net.pending, 1).signal.aborted, true);
  assert.equal(suggester.inFlight(), 0);
});

test("a forced search's answer carries over to the next letter: ?ot answers for ot, and ?ott keeps what starts with ott", () => {
  assert.deepEqual(carriedValues({ text: "?ot", values: ["otter facts", "other", "ottawa"] }, "?ott"), ["otter facts", "ottawa"]);
  assert.deepEqual(carriedValues({ text: "? ot", values: ["otter facts"] }, "? ott"), ["otter facts"]);
});

test("after the engine refuses with 429, no request leaves until the backoff passes, and Retry-After can make it longer", async () => {
  const { net, type, pass } = typing();
  type("p");
  request(net.pending, 0).refuse(429, BLOCKED_BACKOFF_MS * 2);
  await settle();
  for (const text of ["pr", "pro", "pron", "prong"]) type(text);
  assert.equal(net.pending.length, 1, "nothing is sent while the engine is refusing");
  pass(BLOCKED_BACKOFF_MS);
  type("prongh");
  assert.equal(net.pending.length, 1, "Retry-After asked for longer than the base backoff");
  pass(BLOCKED_BACKOFF_MS);
  type("pronghorn");
  assert.equal(net.pending.length, 2);
});

test("a 403 backs off the same way, and the backoff doubles when the engine refuses again", async () => {
  const { net, type, pass } = typing();
  type("a");
  request(net.pending, 0).refuse(403);
  await settle();
  pass(BLOCKED_BACKOFF_MS);
  type("ab");
  request(net.pending, 1).refuse(429);
  await settle();
  pass(BLOCKED_BACKOFF_MS);
  type("abc");
  assert.equal(net.pending.length, 2, "the second refusal waits twice as long");
  pass(BLOCKED_BACKOFF_MS);
  type("abcd");
  assert.equal(net.pending.length, 3);
});

test("after another HTTP error, keys are paced again: only the text left after a pause is asked for, for a while", async () => {
  const { net, type, pass } = typing();
  type("q");
  request(net.pending, 0).refuse(500);
  await settle();
  for (const text of ["qu", "qua", "quag", "quagg"]) {
    type(text);
    pass(PACED_DELAY_MS / 2);
  }
  assert.equal(net.pending.length, 1, "no request while keys come faster than the pace");
  pass(PACED_DELAY_MS);
  assert.deepEqual(
    net.pending.map((p) => p.text),
    ["q", "quagg"],
  );
  pass(PACED_FOR_MS);
  type("quagga");
  assert.equal(net.pending.length, 3, "once the pace lapses, each key asks at once again");
});
