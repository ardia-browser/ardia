import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { monthlySessionForm, parseMonthlyDollars, stripeDonations } from "../lib/donate.mjs";
import { localEvents, localIssues, localStore } from "../lib/backends.mjs";
import { createService } from "../lib/service.mjs";

const servers = [];
after(() => servers.forEach((s) => s.close()));

async function service(donations, { rateLimits = false } = {}) {
  const handle = createService({
    store: localStore("/tmp/ardia-donate-test"), events: localEvents("/tmp/ardia-donate-test"), issues: localIssues("/tmp/ardia-donate-test"),
    secret: "x".repeat(40), publicUrl: () => "https://ardia.example", dashboardUrl: "https://dash.example", rateLimits, log: () => {},
    donations, donateReturnUrl: "https://ardia.example",
  });
  const server = createServer(handle);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("parseMonthlyDollars takes whole dollars from 1 to 10000 only", () => {
  for (const [raw, want] of [["25", 25], [" $7 ", 7], ["1", 1], ["10000", 10000]]) assert.equal(parseMonthlyDollars(raw), want);
  for (const raw of ["0", "10001", "2.5", "-3", "1e3", "", null, "abc", "99999999", "５"]) assert.equal(parseMonthlyDollars(raw), null, String(raw));
});

test("the session form bills the amount monthly on the donation product", () => {
  const form = monthlySessionForm(25, { product: "prod_x", returnUrl: "https://ardia.example" });
  assert.equal(form.get("mode"), "subscription");
  assert.equal(form.get("line_items[0][price_data][unit_amount]"), "2500");
  assert.equal(form.get("line_items[0][price_data][recurring][interval]"), "month");
  assert.equal(form.get("line_items[0][price_data][product]"), "prod_x");
  assert.equal(form.get("cancel_url"), "https://ardia.example/#donate");
});

test("stripeDonations rejects a session without a Checkout URL", async () => {
  const fake = async () => new Response(JSON.stringify({ url: "https://evil.example/x" }), { status: 200 });
  await assert.rejects(stripeDonations({ key: "rk_test_x", returnUrl: "https://a", fetchImpl: fake }).monthlyCheckoutUrl(5));
  const ok = async (url, init) => {
    assert.equal(url, "https://api.stripe.com/v1/checkout/sessions");
    assert.equal(init.headers.Authorization, "Bearer rk_test_x");
    return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_1" }), { status: 200 });
  };
  assert.equal(await stripeDonations({ key: "rk_test_x", returnUrl: "https://a", fetchImpl: ok }).monthlyCheckoutUrl(5), "https://checkout.stripe.com/c/pay/cs_1");
});

const post = (url, body, origin = "https://ardia.example", ip = "203.0.113.1") =>
  fetch(`${url}/api/donate/monthly`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Real-IP": ip, ...(origin ? { Origin: origin } : {}) },
    body,
  });

test("monthly donations stop at 20 sessions per address and 200 overall in 10 minutes", async () => {
  let made = 0;
  const url = await service({ describe: () => "fake", monthlyCheckoutUrl: async () => (made++, "https://checkout.stripe.com/c/pay/cs_4") }, { rateLimits: true });
  for (let i = 0; i < 20; i++) assert.equal((await post(url, "amount=5")).status, 303);
  assert.equal((await post(url, "amount=5")).status, 429);
  for (let i = 1; i <= 180; i++) assert.equal((await post(url, "amount=5", undefined, `198.51.100.${i}`)).status, 303);
  assert.equal((await post(url, "amount=5", undefined, "192.0.2.1")).status, 429);
  assert.equal(made, 200);
});

test("POST /api/donate/monthly redirects to Checkout, or back to the site for a bad amount", async () => {
  const asked = [];
  const url = await service({ describe: () => "fake", monthlyCheckoutUrl: async (d) => (asked.push(d), "https://checkout.stripe.com/c/pay/cs_2") });
  let res = await post(url, "amount=42");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "https://checkout.stripe.com/c/pay/cs_2");
  res = await post(url, "amount=1e2");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "https://ardia.example/#donate");
  assert.equal((await fetch(`${url}/api/donate/monthly?amount=5`, { redirect: "manual" })).status, 405);
  assert.deepEqual(asked, [42]);
});

test("a cross-site or headerless request never reaches Stripe", async () => {
  const asked = [];
  const url = await service({ describe: () => "fake", monthlyCheckoutUrl: async (d) => (asked.push(d), "https://checkout.stripe.com/c/pay/cs_3") });
  assert.equal((await post(url, "amount=5", "https://evil.example")).status, 403);
  assert.equal((await post(url, "amount=5", null)).status, 403);
  const json = await fetch(`${url}/api/donate/monthly`, { method: "POST", headers: { Origin: "https://ardia.example", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(json.status, 415);
  assert.deepEqual(asked, []);
});

test("monthly donations answer 503 when no Stripe key is set, and 502 when Stripe fails", async () => {
  assert.equal((await post(await service(null), "amount=5")).status, 503);
  const failing = await service({ describe: () => "fake", monthlyCheckoutUrl: async () => { throw new Error("down"); } });
  const res = await post(failing, "amount=5");
  assert.equal(res.status, 502);
  assert.equal((await res.json()).backend, "donations");
});
