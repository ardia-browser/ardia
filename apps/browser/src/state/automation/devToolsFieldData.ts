import { OpError } from "./workspaceTargets";

export const FIELD_DATA_ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";
export const FIELD_DATA_TIMEOUT_MS = 8_000;
const METRICS = ["largest_contentful_paint", "cumulative_layout_shift", "interaction_to_next_paint", "first_contentful_paint", "experimental_time_to_first_byte"];

export type FieldDataRequest = { pageUrl: string; apiKey: string; formFactor: "PHONE" | "DESKTOP" | "TABLET" | null };
export type FieldMetric = { p75: number | null; good: number | null; poor: number | null };
export type FieldData = { origin: string; formFactor: string | null; metrics: Record<string, FieldMetric>; collectionPeriod: unknown } | { origin: string; found: false };

const isFields = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number | null => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

export function fieldDataOrigin(pageUrl: string): string {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    throw new OpError("bad_request", "Field data needs the tab to show a web page.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new OpError("bad_request", "Field data needs the tab to show a web page.");
  if (url.username || url.password) throw new OpError("refused", "Field data isn't asked for addresses with a user name or password in them.");
  return url.origin;
}

function metricOf(raw: unknown): FieldMetric {
  const histogram = isFields(raw) && Array.isArray(raw.histogram) ? raw.histogram : [];
  const density = (i: number) => num(isFields(histogram[i]) ? histogram[i].density : null);
  const p75 = isFields(raw) && isFields(raw.percentiles) ? num(raw.percentiles.p75) : null;
  return { p75, good: density(0), poor: density(2) };
}

export async function fetchFieldData(request: FieldDataRequest, fetchFn: typeof fetch = fetch): Promise<FieldData> {
  const origin = fieldDataOrigin(request.pageUrl);
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(request.apiKey)) throw new OpError("bad_request", "fieldDataKey must be an API key made of letters, digits, - and _.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIELD_DATA_TIMEOUT_MS);
  try {
    const body = { origin, metrics: METRICS, ...(request.formFactor ? { formFactor: request.formFactor } : {}) };
    const reply = await fetchFn(`${FIELD_DATA_ENDPOINT}?key=${encodeURIComponent(request.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (reply.status === 404) return { origin, found: false };
    if (!reply.ok) throw new OpError("failed", `Field data answered HTTP ${reply.status}.`);
    const parsed: unknown = await reply.json();
    const record = isFields(parsed) && isFields(parsed.record) ? parsed.record : {};
    const metrics: Record<string, FieldMetric> = {};
    const raw = isFields(record.metrics) ? record.metrics : {};
    for (const name of METRICS) if (Object.hasOwn(raw, name)) metrics[name] = metricOf(raw[name]);
    return { origin, formFactor: request.formFactor, metrics, collectionPeriod: isFields(record.collectionPeriod) ? record.collectionPeriod : null };
  } catch (error) {
    if (error instanceof OpError) throw error;
    throw new OpError("failed", "Field data couldn't be fetched.");
  } finally {
    clearTimeout(timer);
  }
}
