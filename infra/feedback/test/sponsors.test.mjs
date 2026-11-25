import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { HOSTILE_VALUES, embedded } from "../../../scripts/security/hostile-inputs.mjs";
import { localEvents, localIssues, localStore } from "../lib/backends.mjs";
import { DONATE_PRODUCT, monthlySessionForm } from "../lib/donate.mjs";
import { SPONSORS_TIMING, createService } from "../lib/service.mjs";
import {
  IncompleteListError,
  REQUEST_GAP_MS,
  SPONSOR_FIELD,
  SPONSORS_MAX,
  STRIPE_PAGE_BUDGET,
  StripeReadError,
  cleanSponsorName,
  monthlyCentsOf,
  pacer,
  sponsorTier,
  sponsorsFrom,
  stripeSponsors,
} from "../lib/sponsors.mjs";

const servers = [];
after(() => servers.forEach((s) => s.close()));

async function service(sponsors, { rateLimits = false, now = Date.now, log = () => {} } = {}) {
  const handle = createService({
    store: localStore("/tmp/ardia-sponsors-test"), events: localEvents("/tmp/ardia-sponsors-test"), issues: localIssues("/tmp/ardia-sponsors-test"),
    secret: "x".repeat(40), publicUrl: () => "https://ardia.example", dashboardUrl: "https://dash.example", rateLimits, log, now,
    sponsors, donateReturnUrl: "https://ardia.example",
  });
  const server = createServer(handle);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

let seq = 0;
const subscription = ({ id = `sub_${++seq}`, cents = 500, quantity = 1, currency = "usd", priceCurrency = currency, currencyOptions, interval = "month", product = DONATE_PRODUCT, status = "active", metadata = {}, created = seq } = {}) => ({
  id,
  object: "subscription",
  status,
  created,
  metadata,
  customer: "cus_private",
  currency,
  items: { data: [{ quantity, price: { id: `price_${id}`, unit_amount: cents, currency: priceCurrency, ...(currencyOptions ? { currency_options: currencyOptions } : {}), product, recurring: { interval, interval_count: 1 } } }] },
});
const checkout = (name, { donate = "monthly_5", status = "complete", amountTotal = 500 } = {}) => ({
  id: `cs_${++seq}`,
  status,
  mode: "subscription",
  amount_total: amountTotal,
  metadata: { donate },
  customer_details: { email: "donor@example.com", name: "Private Person", address: { city: "Secret City" } },
  custom_fields: name === undefined ? [] : [{ key: SPONSOR_FIELD.key, type: "text", text: { value: name } }],
});
const donor = (name, subOptions = {}, checkoutOptions = {}) => {
  const sub = subscription(subOptions);
  return [sub, checkout(name, checkoutOptions)];
};
const listed = (pairs) => sponsorsFrom(pairs.map(([sub]) => sub), new Map(pairs.map(([sub, session]) => [sub.id, session])));

const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;

function assertShowable(name, label) {
  assert.equal(typeof name, "string", label);
  assert.ok(Array.from(name).length <= SPONSOR_FIELD.maxLength, `${label}: too long`);
  assert.equal(name, name.trim(), `${label}: untrimmed`);
  assert.doesNotMatch(name, HIDDEN_CHARS, `${label}: hidden character`);
  assert.doesNotMatch(name, /\s{2}|[^\S ]/u, `${label}: odd spacing`);
  assert.match(name, /[\p{L}\p{N}]/u, `${label}: nothing readable`);
  const probe = name.normalize("NFKC");
  assert.doesNotMatch(probe, /:\/\/|www\.|\S@\S|^[a-z][a-z0-9+.-]*:\S|\d{1,3}(\.\d{1,3}){3}/iu, `${label}: link or address`);
  assert.doesNotMatch(probe, /\p{Nd}(?:[\s.\-‐-―−_/\\|,:;()#+*]*\p{Nd}){4,}/u, `${label}: long number`);
}

test("cleanSponsorName keeps ordinary names and companies, flattened to one plain line", () => {
  for (const [raw, want] of [
    ["Ada Lovelace", "Ada Lovelace"],
    ["  Zoë   Ångström ", "Zoë Ångström"],
    ["株式会社アーディア", "株式会社アーディア"],
    ["Ａｃｍｅ\u3000Ｃｏ", "Ａｃｍｅ Ｃｏ"],
    ["Ada\nLovelace", "Ada Lovelace"],
    ["Ada\u202eLovelace", "AdaLovelace"],
    ["Ad\u200ba", "Ada"],
    ["Acme Inc.", "Acme Inc."],
    ["J.R.R. Tolkien", "J.R.R. Tolkien"],
    ["Team: Ardia fans", "Team: Ardia fans"],
    ["Version 1.2 fans", "Version 1.2 fans"],
    ["e\u0301\u0301\u0301\u0301\u0301", "é\u0301\u0301"],
    ["x".repeat(80), "x".repeat(SPONSOR_FIELD.maxLength)],
    ["😀a".repeat(30), "😀a".repeat(SPONSOR_FIELD.maxLength / 2)],
  ]) assert.equal(cleanSponsorName(raw), want, JSON.stringify(raw));
});

test("cleanSponsorName refuses links, addresses and names with nothing to read", () => {
  for (const raw of ["https://evil.example", "visit www.evil.example", "acme.io", "Cal.com", "ada@example.com", "javascript:void(0)", "data:text/html,x", "   ", "\u200b\u202e", "!!!", "😀😀", "", null, 42, {}, ["Ada"]]) {
    assert.equal(cleanSponsorName(raw), null, JSON.stringify(raw));
  }
});

test("F6: compatibility forms, IP addresses and addresses past the length cap are refused too", () => {
  for (const raw of [
    "ａｄａ＠ｅｘａｍｐｌｅ．ｃｏｍ",
    "ada﹫example.com",
    "ａｃｍｅ．ｉｏ",
    "acme。io",
    "ｈｔｔｐｓ：／／evil.example",
    "192.168.0.1",
    "Ping 10 . 0 . 0 . 1",
    "１９２．１６８．０．１",
    "2001:db8::1",
    `${"x".repeat(SPONSOR_FIELD.maxLength - 2)} ada@example.com`,
  ]) assert.equal(cleanSponsorName(raw), null, JSON.stringify(raw));
});

test("every shared hostile input reaches the sponsor list clean or not at all", () => {
  let shown = 0;
  for (const { id, value } of HOSTILE_VALUES) {
    const shapes = typeof value === "string" ? embedded(value, "Ada ", " Lovelace") : [value];
    for (const [i, raw] of shapes.entries()) {
      const label = `${id}#${i}`;
      const sponsors = listed([donor(raw)]);
      assert.ok(sponsors.length <= 1, label);
      for (const sponsor of sponsors) {
        assert.deepEqual(Object.keys(sponsor).sort(), ["name", "tier"], label);
        assertShowable(sponsor.name, label);
        shown++;
      }
    }
  }
  assert.ok(shown > 50, `the positive control listed only ${shown}`);
});

test("sponsorTier gives a coarse tier, never the amount", () => {
  assert.equal(sponsorTier(100), "friend");
  assert.equal(sponsorTier(4_999), "friend");
  assert.equal(sponsorTier(5_000), "backer");
  assert.equal(sponsorTier(50_000), "patron");
  assert.equal(sponsorTier(null), "friend");
});

test("R3-5: the tier reads the subscription's own currency, including a multi-currency price", () => {
  const cadOnUsdDefault = subscription({ currency: "cad", priceCurrency: "usd", cents: 100_000, currencyOptions: { cad: { unit_amount: 137_000 } } });
  assert.equal(monthlyCentsOf(cadOnUsdDefault), null);
  const usdOnCadDefault = subscription({ currency: "usd", priceCurrency: "cad", cents: 137_000, currencyOptions: { usd: { unit_amount: 60_000 } } });
  assert.equal(monthlyCentsOf(usdOnCadDefault), 60_000);
  const usdWithoutOption = subscription({ currency: "usd", priceCurrency: "cad", cents: 137_000 });
  assert.equal(monthlyCentsOf(usdWithoutOption), null);
  assert.deepEqual(listed([
    [cadOnUsdDefault, checkout("Canadian Patron")],
    [usdOnCadDefault, checkout("Dollar Patron")],
  ]), [
    { name: "Dollar Patron", tier: "patron" },
    { name: "Canadian Patron", tier: "friend" },
  ]);
});

test("F5: the tier follows the subscription's current recurring USD amount, not the first checkout", () => {
  assert.equal(monthlyCentsOf(subscription({ cents: 100, quantity: 60 })), 6_000);
  assert.equal(monthlyCentsOf(subscription({ cents: 120_000, interval: "year" })), 10_000);
  assert.equal(monthlyCentsOf(subscription({ currency: "eur", cents: 100_000 })), null);
  const mixed = subscription({ cents: 500 });
  mixed.items.data.push({ quantity: 1, price: { unit_amount: 99_999, currency: "usd", product: "prod_other", recurring: { interval: "month" } } });
  assert.equal(monthlyCentsOf(mixed), 500);
  assert.deepEqual(listed([
    donor("Upgraded", { cents: 50_000 }, { amountTotal: 500 }),
    donor("Downgraded", { cents: 500 }, { amountTotal: 100_000 }),
    donor("Euro Patron", { cents: 100_000, currency: "eur" }),
  ]), [
    { name: "Upgraded", tier: "patron" },
    { name: "Downgraded", tier: "friend" },
    { name: "Euro Patron", tier: "friend" },
  ]);
});

test("sponsorsFrom lists active donation subscriptions that opted in, biggest tier first, then longest standing", () => {
  assert.deepEqual(listed([
    donor("Late Friend", { created: 30 }),
    donor("Early Friend", { created: 10 }),
    donor("Big Co", { cents: 100_000, created: 40 }, { donate: "monthly_1000" }),
    donor("Custom Backer", { cents: 7_500, created: 50 }, { donate: "monthly_custom" }),
    donor("Past Due", { status: "past_due" }),
    donor("Hidden By Owner", { metadata: { ardia_sponsor: "hide" } }),
    donor(undefined),
    donor("Other Product", { product: "prod_other" }),
    donor("Not A Donation Checkout", {}, { donate: "" }),
    donor("Open Checkout", {}, { status: "open" }),
    donor("early friend", { created: 60 }),
  ]), [
    { name: "Big Co", tier: "patron" },
    { name: "Custom Backer", tier: "backer" },
    { name: "Early Friend", tier: "friend" },
    { name: "Late Friend", tier: "friend" },
  ]);
  const [sub] = donor("No Checkout");
  assert.deepEqual(sponsorsFrom([sub], new Map([[sub.id, null]])), []);
});

test("sponsorsFrom caps the published list", () => {
  const many = Array.from({ length: SPONSORS_MAX + 20 }, (_, i) => donor(`Donor ${i}`));
  assert.equal(listed(many).length, SPONSORS_MAX);
});

async function holdingTheLoop(run) {
  const hold = setInterval(() => {}, 1000);
  try {
    return await run();
  } finally {
    clearInterval(hold);
  }
}

const ok = (data, has_more = false) => new Response(JSON.stringify({ object: "list", data, has_more }), { status: 200 });

function fakeStripe({ subscriptions, sessions, subscriptionStatus = 200, sessionStatus = 200, pageSize = 100, sessionAnswer = null, prices = new Map(), beforeEach = null }) {
  const calls = { subscriptions: 0, sessions: [], prices: [], startedAt: [], inFlight: 0, maxInFlight: 0 };
  const fetchImpl = async (url, init) => {
    calls.startedAt.push(Date.now());
    assert.equal(init.headers.Authorization, "Bearer rk_test_x");
    const { pathname, searchParams } = new URL(url);
    beforeEach?.(pathname, calls);
    if (pathname.startsWith("/v1/prices/")) {
      const id = decodeURIComponent(pathname.slice("/v1/prices/".length));
      calls.prices.push(id);
      const { currency_options: options, ...price } = prices.get(id);
      const expanded = searchParams.getAll("expand[]").includes("currency_options");
      return new Response(JSON.stringify(expanded ? { ...price, currency_options: options } : price), { status: 200 });
    }
    if (pathname === "/v1/subscriptions") {
      calls.subscriptions++;
      assert.equal(searchParams.get("status"), "active");
      if (subscriptionStatus !== 200) return new Response(JSON.stringify({ error: { code: "permission" } }), { status: subscriptionStatus });
      const after = searchParams.get("starting_after");
      const start = after ? subscriptions.findIndex((s) => s.id === after) + 1 : 0;
      const page = subscriptions.slice(start, start + pageSize);
      return ok(page, start + pageSize < subscriptions.length);
    }
    if (pathname === "/v1/checkout/sessions") {
      const id = searchParams.get("subscription");
      calls.sessions.push(id);
      if (sessionAnswer) {
        calls.inFlight++;
        calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
        try {
          return await sessionAnswer(id, calls.sessions.length, init.signal);
        } finally {
          calls.inFlight--;
        }
      }
      if (sessionStatus !== 200) return new Response("{}", { status: sessionStatus });
      return ok(sessions.has(id) ? [sessions.get(id)] : []);
    }
    throw new Error(`unexpected ${pathname}`);
  };
  return { fetchImpl, calls };
}

test("F3: stripeSponsors starts from active subscriptions, so a long checkout history can't hide a donor", async () => {
  const others = Array.from({ length: 150 }, (_, i) => subscription({ product: `prod_other_${i}` }));
  const [sub, session] = donor("Still Here", { cents: 5_000 });
  const stripe = fakeStripe({ subscriptions: [...others, sub], sessions: new Map([[sub.id, session]]) });
  const sponsors = stripeSponsors({ key: "rk_test_x", fetchImpl: stripe.fetchImpl, requestGapMs: 0 });
  const body = await sponsors.list();
  assert.deepEqual(body, { sponsors: [{ name: "Still Here", tier: "backer" }] });
  assert.equal(stripe.calls.subscriptions, 2);
  assert.deepEqual(stripe.calls.sessions, [sub.id]);
  const text = JSON.stringify(body);
  for (const secret of ["donor@example.com", "Private Person", "Secret City", "cus_private", "5000", "sub_", "cs_"]) assert.ok(!text.includes(secret), secret);
  await sponsors.list();
  assert.deepEqual(stripe.calls.sessions, [sub.id], "a known subscription's checkout isn't fetched again");
});

test("F3: a new hide on the subscription takes the name off at the next refresh", async () => {
  const [sub, session] = donor("Changed Mind");
  const stripe = fakeStripe({ subscriptions: [sub], sessions: new Map([[sub.id, session]]) });
  const sponsors = stripeSponsors({ key: "rk_test_x", fetchImpl: stripe.fetchImpl, requestGapMs: 0 });
  assert.equal((await sponsors.list()).sponsors.length, 1);
  sub.metadata = { ardia_sponsor: "hide" };
  assert.deepEqual(await sponsors.list(), { sponsors: [] });
});

test("F2: stripeSponsors publishes nothing when subscriptions or a checkout can't be read", async () => {
  const [sub, session] = donor("Hidden Donor", { metadata: { ardia_sponsor: "hide" } });
  for (const status of [401, 403, 500]) {
    const stripe = fakeStripe({ subscriptions: [sub], sessions: new Map([[sub.id, session]]), subscriptionStatus: status });
    await assert.rejects(stripeSponsors({ key: "rk_test_x", fetchImpl: stripe.fetchImpl, requestGapMs: 0 }).list(), StripeReadError, String(status));
  }
  const [visible, visibleSession] = donor("Visible");
  const lookupFails = fakeStripe({ subscriptions: [visible], sessions: new Map([[visible.id, visibleSession]]), sessionStatus: 403 });
  await assert.rejects(stripeSponsors({ key: "rk_test_x", fetchImpl: lookupFails.fetchImpl, requestGapMs: 0 }).list(), StripeReadError);
});

test("B: a listing still reporting more at the page budget is incomplete, never a short list", async () => {
  const [sub, session] = donor("On Page One");
  const filler = Array.from({ length: STRIPE_PAGE_BUDGET + 5 }, () => subscription({ product: "prod_other" }));
  const stripe = fakeStripe({ subscriptions: [sub, ...filler], sessions: new Map([[sub.id, session]]), pageSize: 1 });
  await assert.rejects(stripeSponsors({ key: "rk_test_x", fetchImpl: stripe.fetchImpl, requestGapMs: 0 }).list(), IncompleteListError);
  assert.equal(stripe.calls.subscriptions, STRIPE_PAGE_BUDGET);
});

test("F4: a refresh stops at its deadline even when Stripe never answers", async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  await holdingTheLoop(async () => {
    const started = Date.now();
    await assert.rejects(stripeSponsors({ key: "rk_test_x", fetchImpl: hang, deadlineMs: 150 }).list());
    assert.ok(Date.now() - started < 2000);
  });
});

test("custom monthly checkouts ask for the same optional public name", () => {
  const form = monthlySessionForm(25, { product: "prod_x", returnUrl: "https://ardia.example" });
  assert.equal(form.get("custom_fields[0][key]"), SPONSOR_FIELD.key);
  assert.equal(form.get("custom_fields[0][type]"), "text");
  assert.equal(form.get("custom_fields[0][optional]"), "true");
  assert.equal(form.get("custom_fields[0][label][custom]"), SPONSOR_FIELD.label);
  assert.equal(form.get("custom_fields[0][text][maximum_length]"), String(SPONSOR_FIELD.maxLength));
});

function controlledList() {
  const state = { calls: 0, mode: "ok", release: null };
  const backend = {
    describe: () => "fake",
    list: () => {
      state.calls++;
      if (state.mode === "fail") return Promise.reject(new Error("stripe down"));
      if (state.mode === "hang") return new Promise((resolve) => (state.release = () => resolve({ sponsors: [{ name: `Donor ${state.calls}`, tier: "friend" }] })));
      return Promise.resolve({ sponsors: [{ name: `Donor ${state.calls}`, tier: "friend" }] });
    },
  };
  return { state, backend };
}

const getJson = async (url) => {
  const res = await fetch(`${url}/api/sponsors`);
  return { status: res.status, body: await res.json(), res };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("GET /api/sponsors serves one refresh's list for 10 minutes, then only a new refresh's", async () => {
  let clock = 1_000_000;
  const { state, backend } = controlledList();
  const url = await service(backend, { now: () => clock });
  const [a, b] = await Promise.all([getJson(url), getJson(url)]);
  assert.equal(a.status, 200);
  assert.equal(a.res.headers.get("cache-control"), "no-store");
  assert.equal(a.res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(a.body, { sponsors: [{ name: "Donor 1", tier: "friend" }] });
  assert.deepEqual(b.body, a.body);
  assert.equal(state.calls, 1, "concurrent requests share one refresh");
  clock += SPONSORS_TIMING.freshMs - 1;
  assert.deepEqual((await getJson(url)).body, a.body);
  assert.equal(state.calls, 1);
  clock += 1;
  assert.deepEqual((await getJson(url)).body, { sponsors: [{ name: "Donor 2", tier: "friend" }] });
  assert.equal(state.calls, 2);
});

test("R6: a list is fresh for 10 minutes from when its refresh started, so a hide during a slow refresh ends within 10 minutes", async (t) => {
  const coldWait = SPONSORS_TIMING.coldWaitMs;
  SPONSORS_TIMING.coldWaitMs = 50;
  t.after(() => (SPONSORS_TIMING.coldWaitMs = coldWait));
  let clock = 1_000_000;
  const { state, backend } = controlledList();
  state.mode = "hang";
  const url = await service(backend, { now: () => clock });
  assert.equal((await getJson(url)).status, 503);
  const hiddenAt = clock + 5_000;
  clock = hiddenAt + 5_000;
  state.release();
  await settle();
  assert.equal((await getJson(url)).status, 200);
  clock = hiddenAt + SPONSORS_TIMING.freshMs - 5_000;
  state.mode = "fail";
  assert.equal((await getJson(url)).status, 503, "the list started before the hide is gone 10 minutes after the refresh began");
  assert.ok(clock - hiddenAt < SPONSORS_TIMING.freshMs);
});

test("R5: a successful refresh followed by a failed one serves 503, not the old list, and waits out the cooldown", async () => {
  let clock = 1_000_000;
  const { state, backend } = controlledList();
  const url = await service(backend, { now: () => clock });
  assert.equal((await getJson(url)).status, 200);
  state.mode = "fail";
  clock += SPONSORS_TIMING.freshMs;
  const failed = await getJson(url);
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error, "sponsors_unavailable");
  assert.equal(failed.res.headers.get("retry-after"), String(SPONSORS_TIMING.cooldownMs / 1000));
  assert.equal(state.calls, 2);
  clock += SPONSORS_TIMING.cooldownMs - 1;
  assert.equal((await getJson(url)).status, 503);
  assert.equal(state.calls, 2, "no retry inside the cooldown");
  state.mode = "ok";
  clock += 1;
  assert.deepEqual((await getJson(url)).body, { sponsors: [{ name: "Donor 3", tier: "friend" }] });
});

test("R5: while a refresh is still running past the fresh window, the old list isn't served", async (t) => {
  const coldWait = SPONSORS_TIMING.coldWaitMs;
  SPONSORS_TIMING.coldWaitMs = 50;
  t.after(() => (SPONSORS_TIMING.coldWaitMs = coldWait));
  let clock = 1_000_000;
  const { state, backend } = controlledList();
  const url = await service(backend, { now: () => clock });
  assert.equal((await getJson(url)).status, 200);
  state.mode = "hang";
  clock += SPONSORS_TIMING.freshMs;
  assert.equal((await getJson(url)).status, 503);
  assert.equal((await getJson(url)).status, 503);
  assert.equal(state.calls, 2, "the waiting requests share the one refresh");
  state.release();
  await settle();
  assert.deepEqual((await getJson(url)).body, { sponsors: [{ name: "Donor 2", tier: "friend" }] });
});

test("F4: a cold request waits briefly, then answers 503 while the refresh carries on", async (t) => {
  const coldWait = SPONSORS_TIMING.coldWaitMs;
  SPONSORS_TIMING.coldWaitMs = 100;
  t.after(() => (SPONSORS_TIMING.coldWaitMs = coldWait));
  const { state, backend } = controlledList();
  state.mode = "hang";
  const url = await service(backend);
  const started = Date.now();
  assert.equal((await getJson(url)).status, 503);
  assert.ok(Date.now() - started < 1000);
  state.release();
  await settle();
  assert.deepEqual((await getJson(url)).body, { sponsors: [{ name: "Donor 1", tier: "friend" }] });
  assert.equal(state.calls, 1);
});

test("GET /api/sponsors answers 503 when off and when the first refresh fails, 405 for other methods", async () => {
  assert.equal((await fetch(`${await service(null)}/api/sponsors`)).status, 503);
  const failing = await service({ describe: () => "fake", list: async () => { throw new Error("down"); } });
  const res = await fetch(`${failing}/api/sponsors`);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "sponsors_unavailable");
  assert.equal((await fetch(`${failing}/api/sponsors`, { method: "POST" })).status, 405);
});

test("GET /api/sponsors stops at 120 requests per address in 10 minutes", async () => {
  const url = await service({ describe: () => "fake", list: async () => ({ sponsors: [] }) }, { rateLimits: true });
  const get = () => fetch(`${url}/api/sponsors`, { headers: { "X-Real-IP": "203.0.113.9" } });
  for (let i = 0; i < 120; i++) assert.equal((await get()).status, 200);
  assert.equal((await get()).status, 429);
});

test("R3-3: an empty or unfinished checkout lookup isn't cached, so the donor appears once the checkout is there", async () => {
  const [sub, session] = donor("Late Checkout");
  const sessions = new Map();
  const stripe = fakeStripe({ subscriptions: [sub], sessions });
  const sponsors = stripeSponsors({ key: "rk_test_x", fetchImpl: stripe.fetchImpl, requestGapMs: 0 });
  assert.deepEqual(await sponsors.list(), { sponsors: [] });
  sessions.set(sub.id, { ...session, status: "open" });
  assert.deepEqual(await sponsors.list(), { sponsors: [] });
  sessions.set(sub.id, session);
  assert.deepEqual(await sponsors.list(), { sponsors: [{ name: "Late Checkout", tier: "friend" }] });
  assert.deepEqual(stripe.calls.sessions, [sub.id, sub.id, sub.id]);
  await sponsors.list();
  assert.equal(stripe.calls.sessions.length, 3, "a completed checkout is cached");
});

test("R3-4: a cold refresh keeps at most 3 lookups in flight", async () => {
  const pairs = Array.from({ length: 12 }, (_, i) => donor(`Donor ${i}`));
  const stripe = fakeStripe({
    subscriptions: pairs.map(([sub]) => sub),
    sessions: new Map(),
    sessionAnswer: async (id) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return ok([pairs.find(([sub]) => sub.id === id)[1]]);
    },
  });
  const body = await stripeSponsors({ key: "rk_test_x", fetchImpl: stripe.fetchImpl, requestGapMs: 0 }).list();
  assert.equal(body.sponsors.length, 12);
  assert.ok(stripe.calls.maxInFlight <= 3, `in flight ${stripe.calls.maxInFlight}`);
  assert.ok(stripe.calls.maxInFlight > 1, "the lookups do run side by side");
});

test("R3-4: a 429 fails the refresh and no request starts after it", async () => {
  const pairs = Array.from({ length: 40 }, (_, i) => donor(`Donor ${i}`));
  const stripe = fakeStripe({
    subscriptions: pairs.map(([sub]) => sub),
    sessions: new Map(),
    sessionAnswer: async (id, n) => (n === 2 ? new Response(JSON.stringify({ error: { code: "rate_limit" } }), { status: 429 }) : ok([pairs.find(([sub]) => sub.id === id)[1]])),
  });
  const failure = await stripeSponsors({ key: "rk_test_x", fetchImpl: stripe.fetchImpl, requestGapMs: 5 }).list().catch((error) => error);
  assert.ok(failure instanceof StripeReadError);
  assert.equal(failure.status, 429);
  const issued = stripe.calls.startedAt.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(stripe.calls.startedAt.length, issued, "no request after the refresh failed");
  assert.ok(stripe.calls.sessions.length <= 4, `lookups started ${stripe.calls.sessions.length}`);
});

test("R3-4: no request starts after the refresh deadline aborts it", async () => {
  const pairs = Array.from({ length: 40 }, (_, i) => donor(`Donor ${i}`));
  const stripe = fakeStripe({
    subscriptions: pairs.map(([sub]) => sub),
    sessions: new Map(),
    sessionAnswer: (id, n, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
  });
  await holdingTheLoop(async () => {
    await assert.rejects(stripeSponsors({ key: "rk_test_x", fetchImpl: stripe.fetchImpl, deadlineMs: 150, requestGapMs: 0 }).list());
    const issued = stripe.calls.startedAt.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(stripe.calls.startedAt.length, issued);
    assert.ok(stripe.calls.sessions.length <= 3, `lookups started ${stripe.calls.sessions.length}`);
  });
});

test("R4-3: a USD subscription on a price in another default currency is tiered from the expanded price, fetched once", async () => {
  const [sub, session] = donor("Euro Default", { currency: "usd", priceCurrency: "eur", cents: 46_000 });
  const priceId = sub.items.data[0].price.id;
  assert.equal(sub.items.data[0].price.currency_options, undefined, "the list carries Stripe's default shape");
  const [plain, plainSession] = donor("Plain Dollar", { cents: 5_000 });
  const prices = new Map([[priceId, { id: priceId, object: "price", currency: "eur", unit_amount: 46_000, currency_options: { eur: { unit_amount: 46_000 }, usd: { unit_amount: 50_000 } } }]]);
  const stripe = fakeStripe({ subscriptions: [sub, plain], sessions: new Map([[sub.id, session], [plain.id, plainSession]]), prices });
  const sponsors = stripeSponsors({ key: "rk_test_x", fetchImpl: stripe.fetchImpl, requestGapMs: 0 });
  assert.deepEqual(await sponsors.list(), { sponsors: [{ name: "Euro Default", tier: "patron" }, { name: "Plain Dollar", tier: "backer" }] });
  await sponsors.list();
  assert.deepEqual(stripe.calls.prices, [priceId], "only the price whose currency differs, and only once");
});

function manualTime() {
  let now = 0;
  const timers = [];
  return {
    clock: () => now,
    sleep: (ms) => new Promise((resolve) => timers.push({ at: now + ms, resolve })),
    async advanceTo(at) {
      now = at;
      const due = timers.filter((timer) => timer.at <= at);
      timers.splice(0, timers.length, ...timers.filter((timer) => timer.at > at));
      for (const timer of due) timer.resolve();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
    pending: () => timers.length,
  };
}

test("R4-4: the pacer spaces starts by its gap on one shared clock, even when a stall wakes every waiter at once", async () => {
  const time = manualTime();
  const pace = pacer(REQUEST_GAP_MS, time);
  const signal = new AbortController().signal;
  const starts = [];
  const waiters = [1, 2, 3, 4].map(() => pace(signal).then((at) => starts.push(at)));
  await time.advanceTo(0);
  assert.deepEqual(starts, [0]);
  await time.advanceTo(600);
  assert.deepEqual(starts, [0, 600], "the stall released one waiter, not every slot it overslept");
  await time.advanceTo(600 + REQUEST_GAP_MS - 1);
  assert.deepEqual(starts, [0, 600]);
  await time.advanceTo(600 + REQUEST_GAP_MS);
  await time.advanceTo(600 + 2 * REQUEST_GAP_MS);
  await Promise.all(waiters);
  assert.deepEqual(starts, [0, 600, 600 + REQUEST_GAP_MS, 600 + 2 * REQUEST_GAP_MS]);
  assert.equal(time.pending(), 0);
});

test("R4-4: a paced wait stops when the refresh is aborted", async () => {
  const time = manualTime();
  const pace = pacer(REQUEST_GAP_MS, { clock: time.clock, sleep: (ms, signal) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))) });
  const stop = new AbortController();
  await pace(stop.signal);
  const waiting = pace(stop.signal);
  stop.abort(new Error("refresh failed"));
  await assert.rejects(waiting, /refresh failed/);
});

test("R4-5: no request starts once a 429's status is known, even while its body is still arriving", async () => {
  const pairs = Array.from({ length: 30 }, (_, i) => donor(`Donor ${i}`));
  let headersAt = Infinity;
  const stripe = fakeStripe({
    subscriptions: pairs.map(([sub]) => sub),
    sessions: new Map(),
    sessionAnswer: async (id, n) => {
      if (n !== 2) return ok([pairs.find(([sub]) => sub.id === id)[1]]);
      headersAt = Date.now();
      const body = new ReadableStream({
        start(controller) {
          setTimeout(() => {
            try {
              controller.enqueue(new TextEncoder().encode("{}"));
              controller.close();
            } catch {}
          }, 600);
        },
      });
      return new Response(body, { status: 429 });
    },
  });
  await holdingTheLoop(async () => {
    const failure = await stripeSponsors({ key: "rk_test_x", fetchImpl: stripe.fetchImpl, requestGapMs: 20 }).list().catch((error) => error);
    assert.equal(failure?.status, 429);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const late = stripe.calls.startedAt.filter((at) => at > headersAt);
    assert.equal(late.length, 0, `${late.length} requests started after the 429`);
  });
});

function codexStripe({ subscriptions, names, pageSize = 100 }) {
  const behaviour = { holdOpen: new Set(), rateLimited: new Set(), pageTwo: 200, release: [] };
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === "/v1/subscriptions") {
      const after = searchParams.get("starting_after");
      if (after && behaviour.pageTwo !== 200) return new Response("{}", { status: behaviour.pageTwo });
      const start = after ? subscriptions.findIndex((s) => s.id === after) + 1 : 0;
      return ok(subscriptions.slice(start, start + pageSize), start + pageSize < subscriptions.length);
    }
    const id = searchParams.get("subscription");
    if (behaviour.rateLimited.has(id)) return new Response("{}", { status: 429 });
    if (behaviour.holdOpen.has(id)) {
      return new Promise((resolve, reject) => {
        behaviour.release.push(() => resolve(ok([checkout(names[id])])));
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    }
    return ok([checkout(names[id])]);
  };
  return { fetchImpl, behaviour };
}

async function codexService(stripe, t) {
  const coldWait = SPONSORS_TIMING.coldWaitMs;
  SPONSORS_TIMING.coldWaitMs = 50;
  t.after(() => (SPONSORS_TIMING.coldWaitMs = coldWait));
  const time = { clock: 1_000_000 };
  const url = await service(stripeSponsors({ key: "rk_test_x", fetchImpl: stripe.fetchImpl, requestGapMs: 0 }), { now: () => time.clock });
  const rows = async () => {
    const { status, body } = await getJson(url);
    return status === 200 ? body.sponsors : status;
  };
  const served = async () => {
    const answer = await rows();
    return Array.isArray(answer) ? answer.map((s) => s.name) : answer;
  };
  return { time, served, rows };
}

test("R5 Codex A: a hide with an unrelated checkout lookup held open, or answering 429, never serves the hidden name", async (t) => {
  for (const variant of ["held open", "429"]) {
    const alice = subscription();
    const bob = subscription();
    const carol = subscription();
    const names = { [alice.id]: "Alice Hidden", [bob.id]: "Bob Visible", [carol.id]: "Carol New" };
    const subscriptions = [alice, bob];
    const stripe = codexStripe({ subscriptions, names });
    const { time, served } = await codexService(stripe, t);
    assert.deepEqual(await served(), ["Alice Hidden", "Bob Visible"], variant);
    alice.metadata = { ardia_sponsor: "hide" };
    subscriptions.push(carol);
    (variant === "held open" ? stripe.behaviour.holdOpen : stripe.behaviour.rateLimited).add(carol.id);
    time.clock += SPONSORS_TIMING.freshMs;
    assert.equal(await served(), 503, variant);
    await settle();
    assert.equal(await served(), 503, variant);
    for (const release of stripe.behaviour.release) release();
  }
});

test("R5 Codex B: a hide on page 1 with a 429 on page 2 never serves the hidden name", async (t) => {
  const alice = subscription();
  const bob = subscription();
  const names = { [alice.id]: "Alice Hidden", [bob.id]: "Bob Visible" };
  const stripe = codexStripe({ subscriptions: [alice, bob], names, pageSize: 1 });
  const { time, served } = await codexService(stripe, t);
  assert.deepEqual(await served(), ["Alice Hidden", "Bob Visible"]);
  alice.metadata = { ardia_sponsor: "hide" };
  stripe.behaviour.pageTwo = 429;
  time.clock += SPONSORS_TIMING.freshMs;
  assert.equal(await served(), 503);
  await settle();
  assert.equal(await served(), 503);
  stripe.behaviour.pageTwo = 200;
  time.clock += SPONSORS_TIMING.cooldownMs;
  assert.deepEqual(await served(), ["Bob Visible"]);
});

test("R5 Codex C: a hidden patron sharing a name never lends the row its spelling or tier, even when a lookup fails", async (t) => {
  const patron = subscription({ cents: 100_000, created: 1 });
  const friend = subscription({ cents: 500, created: 2 });
  const newcomer = subscription({ created: 3 });
  const names = { [patron.id]: "ADA RIVERA", [friend.id]: "Ada Rivera", [newcomer.id]: "New Donor" };
  const subscriptions = [patron, friend];
  const stripe = codexStripe({ subscriptions, names });
  const { time, served, rows } = await codexService(stripe, t);
  assert.deepEqual(await rows(), [{ name: "ADA RIVERA", tier: "patron" }]);
  patron.metadata = { ardia_sponsor: "hide" };
  subscriptions.push(newcomer);
  stripe.behaviour.rateLimited.add(newcomer.id);
  time.clock += SPONSORS_TIMING.freshMs;
  assert.equal(await served(), 503);
  stripe.behaviour.rateLimited.delete(newcomer.id);
  time.clock += SPONSORS_TIMING.cooldownMs;
  assert.deepEqual(await rows(), [{ name: "Ada Rivera", tier: "friend" }, { name: "New Donor", tier: "friend" }]);
});

test("R5: each row is one visible subscription's own name and tier", () => {
  const patron = [subscription({ cents: 100_000, created: 1 }), checkout("ADA RIVERA")];
  const friend = [subscription({ cents: 500, created: 2 }), checkout("Ada Rivera")];
  assert.deepEqual(listed([friend, patron]), [{ name: "ADA RIVERA", tier: "patron" }]);
  patron[0].metadata = { ardia_sponsor: "hide" };
  assert.deepEqual(listed([patron, friend]), [{ name: "Ada Rivera", tier: "friend" }]);
  patron[0].metadata = {};
  patron[0].status = "canceled";
  assert.deepEqual(listed([patron, friend]), [{ name: "Ada Rivera", tier: "friend" }]);
  const early = [subscription({ cents: 500, created: 1 }), checkout("Sam Lee")];
  const late = [subscription({ cents: 500, created: 9 }), checkout("SAM LEE")];
  assert.deepEqual(listed([late, early]), [{ name: "Sam Lee", tier: "friend" }], "a tie goes to the longest-standing subscription, spelling and all");
});

test("R5: names carrying identifying numbers are refused", () => {
  for (const raw of [
    "078-05-1120",
    "Ada 078 05 1120",
    "０７８－０５－１１２０",
    "4111 1111 1111 1111",
    "Card 4111-1111-1111-1111",
    "Call 555.123.4567",
    "12345",
    "Ref ١٢٣٤٥",
    "123 • 45 • 6789",
    "4111 • 1111 • 1111 • 1111",
    "４１１１ • １１１１ • １１１１ • １１１１",
    "Ada 123 Bo 4567",
  ]) assert.equal(cleanSponsorName(raw), null, JSON.stringify(raw));
  for (const kept of ["Studio 54", "Team 2026", "Version 1.2 fans", "Apollo 11 Club", "Route 66 Studio 54"]) assert.equal(cleanSponsorName(kept), kept);
});
