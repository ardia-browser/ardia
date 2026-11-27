export const MONTHLY_MIN_DOLLARS = 1;
export const MONTHLY_MAX_DOLLARS = 10_000;
export const DONATE_PRODUCT = "prod_Vfh8KWt8NYQmm0";
export const SPONSOR_FIELD = {
  key: "sponsorname",
  label: "Name or company to show publicly on ardia.dev",
  maxLength: 40,
};

export function parseMonthlyDollars(raw) {
  const text = String(raw ?? "").trim().replace(/^\$/, "");
  if (!/^\d{1,5}$/.test(text)) return null;
  const dollars = Number(text);
  return dollars >= MONTHLY_MIN_DOLLARS && dollars <= MONTHLY_MAX_DOLLARS ? dollars : null;
}

export function monthlySessionForm(dollars, { product, returnUrl }) {
  return new URLSearchParams({
    mode: "subscription",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][product]": product,
    "line_items[0][price_data][unit_amount]": String(dollars * 100),
    "line_items[0][price_data][recurring][interval]": "month",
    "subscription_data[metadata][donate]": "monthly_custom",
    "metadata[donate]": "monthly_custom",
    "custom_fields[0][key]": SPONSOR_FIELD.key,
    "custom_fields[0][type]": "text",
    "custom_fields[0][optional]": "true",
    "custom_fields[0][label][type]": "custom",
    "custom_fields[0][label][custom]": SPONSOR_FIELD.label,
    "custom_fields[0][text][maximum_length]": String(SPONSOR_FIELD.maxLength),
    success_url: `${returnUrl}/?donated=monthly#donate`,
    cancel_url: `${returnUrl}/#donate`,
  });
}

export function stripeDonations({ key, product = DONATE_PRODUCT, returnUrl, fetchImpl = fetch }) {
  return {
    describe: () => `Stripe Checkout (${key.startsWith("rk_live_") || key.startsWith("sk_live_") ? "live" : "test"})`,
    async monthlyCheckoutUrl(dollars) {
      const response = await fetchImpl("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: monthlySessionForm(dollars, { product, returnUrl }),
        signal: AbortSignal.timeout(10_000),
      });
      const session = await response.json().catch(() => null);
      if (!response.ok || typeof session?.url !== "string" || !session.url.startsWith("https://checkout.stripe.com/")) {
        throw new Error(`checkout session failed with ${response.status}: ${session?.error?.code ?? "no url"}`);
      }
      return session.url;
    },
  };
}
