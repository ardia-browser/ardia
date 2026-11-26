import {
  validatePluginDetail,
  validateRegistryIndex,
  validateRevocationList,
  verifySignedJson,
  type PublicKeys,
  type RegistryIndexPayload,
  type RegistryPluginPayload,
  type RegistryRevocationsPayload,
  type Validated,
} from "@ardia/plugin-sdk/registry";
import { readDocument, writeDocument } from "../../platform/documents";
import { pluginSubtle } from "../../platform/pluginCrypto";
import { isFields } from "../../lib/decode";
import { splitPluginId } from "../../lib/pluginIds";
import { defaultRegistryKeys, defaultRegistryUrl, registryUrl } from "./registryKeys";
import { pluginsExtras, type CustomRegistry } from "./savedState";

export type RegistryRef = { url: string; keys: PublicKeys; scopes: string[] | null; isDefault: boolean };

export type FetchedResponse = { status: number; header(name: string): string | null; text(): Promise<string> };

export type RegistryFetcher = (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<FetchedResponse>;

export type SignedResult<T> = { ok: true; value: T; fresh: boolean; envelope: unknown } | { ok: false; code: "offline" | "verify" | "missing" | "keys"; reason: string };

const CACHE_DOC = "Plugins/registry-cache.json";
const MAX_BODY = 8 << 20;
const MAX_CACHED = 128;
const TIMEOUT_MS = 20_000;

const realFetch: RegistryFetcher = async (url, headers, signal) => {
  const response = await fetch(url, { headers, signal, cache: "no-store" } as RequestInit);
  return { status: response.status, header: (name) => response.headers.get(name), text: () => response.text() };
};

let fetcher: RegistryFetcher = realFetch;

export const setRegistryFetcherForTests = (given: RegistryFetcher | null) => void (fetcher = given ?? realFetch);

export const registryFetcher = (): RegistryFetcher => fetcher;

type Cached = { etag: string; envelope: unknown; at: number };

let cache: Record<string, Cached> | null = null;

function cached(): Record<string, Cached> {
  if (cache) return cache;
  cache = {};
  try {
    const doc = JSON.parse(readDocument(CACHE_DOC) ?? "{}") as unknown;
    if (isFields(doc) && isFields(doc.entries)) {
      for (const [url, entry] of Object.entries(doc.entries)) {
        if (isFields(entry) && typeof entry.etag === "string" && typeof entry.at === "number") cache[url] = { etag: entry.etag, envelope: entry.envelope, at: entry.at };
      }
    }
  } catch {
    cache = {};
  }
  return cache;
}

function remember(url: string, entry: Cached) {
  const all = { ...cached(), [url]: entry };
  const kept = Object.entries(all)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_CACHED);
  cache = Object.fromEntries(kept);
  try {
    writeDocument(CACHE_DOC, `${JSON.stringify({ version: 1, entries: cache })}\n`);
  } catch {}
}

export const resetRegistryCacheForTests = () => void (cache = null);

export function defaultRegistry(): RegistryRef {
  return { url: defaultRegistryUrl(), keys: defaultRegistryKeys(), scopes: null, isDefault: true };
}

const customRef = (r: CustomRegistry): RegistryRef | null => {
  const url = registryUrl(r.url);
  return url ? { url, keys: r.keys, scopes: r.scopes, isDefault: false } : null;
};

export function customRegistries(): RegistryRef[] {
  return pluginsExtras().registries.flatMap((r) => customRef(r) ?? []);
}

export function registryForUrl(url: string): RegistryRef | null {
  const wanted = registryUrl(url, true);
  if (!wanted) return null;
  const known = [defaultRegistry(), ...customRegistries()].find((r) => r.url === wanted);
  return known ?? null;
}

export function registryForId(id: string): RegistryRef {
  const scope = splitPluginId(id)?.scope;
  const bound = scope ? customRegistries().find((r) => r.scopes?.includes(`@${scope}`)) : undefined;
  return bound ?? defaultRegistry();
}

async function fetchEnvelope(url: string): Promise<{ ok: true; envelope: unknown; fresh: boolean } | { ok: false; code: "offline" | "missing"; reason: string }> {
  const known = cached()[url];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const response = await fetcher(url, { Accept: "application/json", ...(known ? { "If-None-Match": known.etag } : {}) }, abort.signal);
    if (response.status === 304 && known) return { ok: true, envelope: known.envelope, fresh: false };
    if (response.status === 404) return { ok: false, code: "missing", reason: "The registry doesn't list it" };
    if (response.status !== 200) return { ok: false, code: "offline", reason: `The registry answered ${response.status}` };
    const text = await response.text();
    if (text.length > MAX_BODY) return { ok: false, code: "offline", reason: "The registry's answer is too big" };
    const envelope = JSON.parse(text) as unknown;
    const etag = response.header("etag");
    if (etag && etag.length <= 256) remember(url, { etag, envelope, at: Date.now() });
    return { ok: true, envelope, fresh: true };
  } catch (error) {
    if (known) return { ok: true, envelope: known.envelope, fresh: false };
    return { ok: false, code: "offline", reason: error instanceof SyntaxError ? "The registry's answer isn't JSON" : "Couldn't reach the plugin registry" };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSigned<T>(ref: RegistryRef, path: string, validate: (payload: unknown) => Validated<T>): Promise<SignedResult<T>> {
  const keys = ref.keys instanceof Map ? ref.keys : Object.keys(ref.keys);
  if ((Array.isArray(keys) ? keys.length : keys.size) === 0) return { ok: false, code: "keys", reason: "This Ardia has no key for that registry, so nothing from it is trusted" };
  const got = await fetchEnvelope(`${ref.url}/${path}`);
  if (!got.ok) return got;
  const verified = await verifySignedJson(got.envelope, ref.keys, validate, { subtle: pluginSubtle() });
  if (!verified.ok) return { ok: false, code: "verify", reason: `The registry's answer didn't verify: ${verified.problems[0] ?? "unknown"}` };
  return { ok: true, value: verified.value, fresh: got.fresh, envelope: got.envelope };
}

export const fetchIndex = (ref: RegistryRef): Promise<SignedResult<RegistryIndexPayload>> => fetchSigned(ref, "index.json", validateRegistryIndex);

export function fetchDetail(ref: RegistryRef, id: string): Promise<SignedResult<RegistryPluginPayload>> {
  const parts = splitPluginId(id);
  if (!parts) return Promise.resolve({ ok: false, code: "missing", reason: `${id} isn't a plugin id` });
  return fetchSigned(ref, `plugins/@${parts.scope}/${parts.name}.json`, (payload) => validatePluginDetail(payload, id));
}

export const fetchRevocationList = (ref: RegistryRef, minSeq: number): Promise<SignedResult<RegistryRevocationsPayload>> =>
  fetchSigned(ref, "revocations.json", (payload) => validateRevocationList(payload, { minSeq }));

export const verifyCachedEnvelope = <T>(ref: RegistryRef, envelope: unknown, validate: (payload: unknown) => Validated<T>) =>
  verifySignedJson(envelope, ref.keys, validate, { subtle: pluginSubtle() });
