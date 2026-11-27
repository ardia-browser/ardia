import { DONATE_PRODUCT, SPONSOR_FIELD } from "./donate.mjs";

export { SPONSOR_FIELD };
export const SPONSOR_TIERS = [
  { tier: "patron", minCents: 50_000 },
  { tier: "backer", minCents: 5_000 },
  { tier: "friend", minCents: 0 },
];
export const TIER_CURRENCY = "usd";
export const SPONSORS_MAX = 200;
export const HIDE_METADATA = { key: "ardia_sponsor", value: "hide" };
export const STRIPE_PAGE_BUDGET = 20;
export const REFRESH_DEADLINE_MS = 20_000;

export const LOOKUP_CONCURRENCY = 3;
export const REQUEST_GAP_MS = 120;

const REQUEST_TIMEOUT_MS = 8_000;
const SPACING = /[\p{Cc}\p{Zl}\p{Zp}\s]+/gu;
const INVISIBLE = /[\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu;
const PILED_MARKS = /(\p{M}{2})\p{M}+/gu;
const DOT_LOOKALIKES = /[。｡︒․⸳·]/gu;
const URL_LIKE = /[a-z][a-z0-9+.-]*:\S|www\.|[\p{L}\p{N}-]+\.[\p{L}]{2,}(?![\p{L}\p{N}])/iu;
const EMAIL_LIKE = /\S@\S/u;
const IPV4_LIKE = /(?<![\p{N}.])\d{1,3}(?:\s*\.\s*\d{1,3}){3}(?![\p{N}])/u;
const IPV6_LIKE = /(?:^|[^\p{L}\p{N}])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,}/iu;
const NUMBER_SEPARATORS = "[\\s.\\-‐-―−_/\\\\|,:;()#+*]*";
const LONG_NUMBER = new RegExp(`\\p{Nd}(?:${NUMBER_SEPARATORS}\\p{Nd}){4,}`, "u");
const DIGIT = /\p{Nd}/gu;
const MOST_DIGITS = 6;
const READABLE = /[\p{L}\p{N}]/u;

const PROBE_CODE_POINTS = SPONSOR_FIELD.maxLength * 4;

const looksLikeAddress = (text) => {
  const probe = Array.from(text.slice(0, PROBE_CODE_POINTS * 2)).slice(0, PROBE_CODE_POINTS).join("").normalize("NFKC").replace(DOT_LOOKALIKES, ".");
  return URL_LIKE.test(probe) || EMAIL_LIKE.test(probe) || IPV4_LIKE.test(probe) || IPV6_LIKE.test(probe) || LONG_NUMBER.test(probe) || (probe.match(DIGIT)?.length ?? 0) > MOST_DIGITS;
};

export function cleanSponsorName(raw) {
  if (typeof raw !== "string") return null;
  const flat = raw.normalize("NFC").replace(INVISIBLE, "").replace(SPACING, " ").replace(PILED_MARKS, "$1").trim();
  if (looksLikeAddress(flat)) return null;
  const name = Array.from(flat).slice(0, SPONSOR_FIELD.maxLength).join("").trim();
  return READABLE.test(name) ? name : null;
}

export function sponsorTier(monthlyCents) {
  const cents = Number.isFinite(monthlyCents) ? monthlyCents : 0;
  return SPONSOR_TIERS.find((t) => cents >= t.minCents).tier;
}

const tierRank = (tier) => SPONSOR_TIERS.findIndex((t) => t.tier === tier);
const idOf = (ref) => (typeof ref === "string" ? ref : ref?.id);
const itemsOf = (subscription) => (Array.isArray(subscription?.items?.data) ? subscription.items.data : []);
const isDonation = (subscription, product) => itemsOf(subscription).some((item) => idOf(item?.price?.product) === product);

const MONTHS_PER_INTERVAL = { month: 1, year: 12 };

const unitAmountIn = (price, currency) =>
  price?.currency === currency ? price.unit_amount : price?.currency_options?.[currency]?.unit_amount;

export const needsCurrencyOptions = (subscription, product = DONATE_PRODUCT) =>
  subscription?.currency !== TIER_CURRENCY
    ? []
    : itemsOf(subscription)
    .map((item) => item?.price)
    .filter((price) => idOf(price?.product) === product && price.currency !== subscription.currency && typeof price.id === "string");

export function monthlyCentsOf(subscription, product = DONATE_PRODUCT, pricesById = new Map()) {
  const currency = subscription?.currency;
  if (currency !== TIER_CURRENCY) return null;
  let cents = 0;
  for (const item of itemsOf(subscription)) {
    const price = item?.price;
    if (idOf(price?.product) !== product) continue;
    const amount = unitAmountIn(price, currency) ?? unitAmountIn(pricesById.get(price.id), currency);
    if (amount === null || amount === undefined) return null;
    const months = MONTHS_PER_INTERVAL[price.recurring?.interval] * (Number(price.recurring?.interval_count) || 1);
    const unit = Number(amount);
    const quantity = Number(item.quantity ?? 1);
    if (!Number.isFinite(months) || !Number.isFinite(unit) || !Number.isFinite(quantity)) return null;
    cents += (unit * quantity) / months;
  }
  return cents;
}

const fieldValue = (session) =>
  (Array.isArray(session?.custom_fields) ? session.custom_fields : []).find((f) => f?.key === SPONSOR_FIELD.key)?.text?.value;

export const publishable = (subscription, product = DONATE_PRODUCT) =>
  subscription?.status === "active" && isDonation(subscription, product) && subscription.metadata?.[HIDE_METADATA.key] !== HIDE_METADATA.value;

const outranks = (a, b) => tierRank(a.tier) < tierRank(b.tier) || (a.tier === b.tier && a.since < b.since);

export function sponsorsFrom(activeSubscriptions, sessionBySubscription, product = DONATE_PRODUCT, pricesById = new Map()) {
  const seen = new Map();
  for (const subscription of activeSubscriptions) {
    if (!publishable(subscription, product)) continue;
    const session = sessionBySubscription.get(subscription.id);
    if (session?.status !== "complete" || !String(session.metadata?.donate ?? "").startsWith("monthly_")) continue;
    const name = cleanSponsorName(fieldValue(session));
    if (!name) continue;
    const sponsor = { name, tier: sponsorTier(monthlyCentsOf(subscription, product, pricesById) ?? 0), since: Number(subscription.created) || 0 };
    const key = name.toLocaleLowerCase("en-US");
    const earlier = seen.get(key);
    if (!earlier || outranks(sponsor, earlier)) seen.set(key, sponsor);
  }
  return [...seen.values()]
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.since - b.since)
    .slice(0, SPONSORS_MAX)
    .map(({ name, tier }) => ({ name, tier }));
}


export class StripeReadError extends Error {
  constructor(status, code) {
    super(`stripe answered ${status}: ${code ?? "no code"}`);
    this.status = status;
  }
}

export class IncompleteListError extends Error {}

const finishedCheckout = (session) =>
  session?.status === "complete"
    ? {
        status: session.status,
        metadata: { donate: session.metadata?.donate },
        custom_fields: [{ key: SPONSOR_FIELD.key, text: { value: fieldValue(session) } }],
      }
    : null;

const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    const stopWaiting = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stopWaiting);
      resolve();
    }, ms);
    signal.addEventListener("abort", stopWaiting, { once: true });
  });

export function pacer(gapMs, { clock = Date.now, sleep = pause } = {}) {
  let nextAt = -Infinity;
  return async (signal) => {
    for (;;) {
      signal.throwIfAborted();
      const now = clock();
      if (now >= nextAt) {
        nextAt = now + gapMs;
        return now;
      }
      await sleep(nextAt - now, signal);
    }
  };
}

async function eachLimited(items, limit, signal, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal.aborted) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  signal.throwIfAborted();
}

const PRICE_CACHE_MS = 24 * 60 * 60 * 1000;

export function stripeSponsors({ key, product = DONATE_PRODUCT, fetchImpl = fetch, deadlineMs = REFRESH_DEADLINE_MS, requestGapMs = REQUEST_GAP_MS, now = Date.now }) {
  const sessions = new Map();
  const prices = new Map();

  const get = async (path, params, refresh, { list = true } = {}) => {
    await refresh.pace(refresh.signal);
    const response = await fetchImpl(`https://api.stripe.com/v1/${path}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.any([refresh.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) {
      const error = new StripeReadError(response.status);
      refresh.fail(error);
      response.body?.cancel().catch(() => {});
      throw error;
    }
    const body = await response.json().catch(() => null);
    if (list ? !Array.isArray(body?.data) : typeof body?.id !== "string") {
      const error = new StripeReadError(response.status, "unexpected_body");
      refresh.fail(error);
      throw error;
    }
    return body;
  };

  const listAll = async (path, params, refresh) => {
    const items = [];
    let after = null;
    for (let page = 0; page < STRIPE_PAGE_BUDGET; page++) {
      const body = await get(path, { ...params, limit: "100", ...(after ? { starting_after: after } : {}) }, refresh);
      items.push(...body.data);
      if (!body.has_more) return items;
      if (body.data.length === 0) break;
      after = body.data[body.data.length - 1].id;
    }
    throw new IncompleteListError(`${path} still had more after ${STRIPE_PAGE_BUDGET} pages`);
  };

  const pricesById = () => new Map([...prices].map(([id, { price }]) => [id, price]));

  return {
    describe: () => "Stripe subscriptions",
    async list() {
      const stop = new AbortController();
      const refresh = {
        signal: AbortSignal.any([AbortSignal.timeout(deadlineMs), stop.signal]),
        pace: pacer(requestGapMs),
        fail: (error) => stop.abort(error),
      };
      try {
        const donations = (await listAll("subscriptions", { status: "active" }, refresh)).filter((s) => isDonation(s, product));
        const visible = new Set(donations.filter((s) => publishable(s, product)).map((s) => s.id));
        for (const id of sessions.keys()) if (!visible.has(id)) sessions.delete(id);
        const missing = donations.filter((s) => visible.has(s.id) && !sessions.has(s.id));
        await eachLimited(missing, LOOKUP_CONCURRENCY, refresh.signal, async (subscription) => {
          const body = await get("checkout/sessions", { subscription: subscription.id, limit: "1" }, refresh);
          const checkout = finishedCheckout(body.data[0]);
          if (checkout) sessions.set(subscription.id, checkout);
        });
        const stalePrices = [
          ...new Set(
            donations
              .filter((s) => visible.has(s.id) && sessions.has(s.id))
              .flatMap((s) => needsCurrencyOptions(s, product))
              .map((price) => price.id)
              .filter((id) => !prices.has(id) || now() - prices.get(id).at >= PRICE_CACHE_MS),
          ),
        ];
        await eachLimited(stalePrices, LOOKUP_CONCURRENCY, refresh.signal, async (id) => {
          const price = await get(`prices/${encodeURIComponent(id)}`, { "expand[]": "currency_options" }, refresh, { list: false });
          prices.set(id, { price, at: now() });
        });
        return { sponsors: sponsorsFrom(donations, sessions, product, pricesById()) };
      } catch (error) {
        refresh.fail(error);
        throw error;
      }
    },
  };
}
