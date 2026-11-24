import { asSecret, isSecret, reveal, type Secret } from "@ardia/core";
import { keychainDelete, keychainGetSecret, keychainSetSecret } from "../../platform/keychain";
import { devTestValue } from "../../platform/launchConfig";
import { namesRateLimit } from "./githubLimits";
import { LiveError, type LiveSourceId } from "./types";

const mock = (() => {
  try {
    return devTestValue("liveMock");
  } catch {
    return null;
  }
})();

export const isMocked = !!mock;

export const endpoints = {
  githubGraphql: mock ? `${mock}/github/graphql` : "https://api.github.com/graphql",
  githubWeb: mock ? `${mock}/github` : "https://github.com",
  bitbucket: mock ? `${mock}/bitbucket/2.0` : "https://api.bitbucket.org/2.0",
  notion: mock ? `${mock}/notion/v1` : "https://api.notion.com/v1",
  confluence: (site: string) => (mock ? `${mock}/confluence` : site.replace(/\/$/, "")),
  googleAuth: mock ? `${mock}/google/auth` : "https://accounts.google.com/o/oauth2/v2/auth",
  googleToken: mock ? `${mock}/google/token` : "https://oauth2.googleapis.com/token",
  drive: mock ? `${mock}/google/drive/v3` : "https://www.googleapis.com/drive/v3",
};

export async function request<T>(url: string, init: RequestInit = {}, onHeaders?: (headers: Headers) => void): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { Accept: "application/json", ...init.headers } });
  } catch {
    throw new LiveError("network", "Couldn't connect");
  }
  onHeaders?.(res.headers);
  if (res.status === 401) throw new LiveError("signedOut", "Signed out");
  if (res.status === 403 && res.headers.get("x-github-sso")) throw new LiveError("sso", "Needs Single Sign-On");
  if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) throw new LiveError("rateLimited", "Rate Limit Exceeded");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 403 && namesRateLimit(text)) throw new LiveError("rateLimited", "Rate Limit Exceeded");
    throw new LiveError(res.status === 403 ? "signedOut" : "other", `The server answered ${res.status}`);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new LiveError("other", "The server's answer couldn't be read");
  }
}

export const form = (fields: Record<string, string | Secret>) =>
  Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(isSecret(v) ? reveal(v) : v)}`)
    .join("&");

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64(text: string): string {
  const bytes = [...new TextEncoder().encode(text)];
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = [bytes[i]!, bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : "=") + (i + 2 < bytes.length ? B64[n & 63]! : "=");
  }
  return out;
}

export const basic = (user: string, secret: Secret) => `Basic ${base64(`${user}:${reveal(secret)}`)}`;
export const bearer = (token: Secret) => `Bearer ${reveal(token)}`;

export type LiveToken = Secret<"oauthToken" | "apiToken">;

const TOKEN_KIND = { github: "oauthToken", bitbucket: "apiToken", notion: "apiToken", confluence: "apiToken", gdrive: "oauthToken" } as const satisfies Record<LiveSourceId, LiveToken["kind"]>;

const account = (source: LiveSourceId) => (mock ? `mock:${source}` : source);
export const getSecret = (source: LiveSourceId): Promise<LiveToken | null> => keychainGetSecret(account(source), TOKEN_KIND[source]);
export const setSecret = (source: LiveSourceId, secret: LiveToken) => keychainSetSecret(account(source), secret);
export const deleteSecret = (source: LiveSourceId) => keychainDelete(account(source));

export type GoogleTokens = { access_token: Secret<"oauthToken">; refresh_token: Secret<"oauthToken">; expires_at: number; client_secret: Secret<"oauthClientSecret"> };

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function googleTokensOf(stored: LiveToken): GoogleTokens {
  let raw: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(reveal(stored));
    raw = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {}
  if (!raw || !isText(raw.access_token) || !isText(raw.refresh_token) || !isText(raw.client_secret) || typeof raw.expires_at !== "number") {
    throw new LiveError("signedOut", "The saved Google sign-in can't be read");
  }
  return {
    access_token: asSecret("oauthToken", raw.access_token),
    refresh_token: asSecret("oauthToken", raw.refresh_token),
    expires_at: raw.expires_at,
    client_secret: asSecret("oauthClientSecret", raw.client_secret),
  };
}

export const storedGoogleTokens = (tokens: GoogleTokens): LiveToken =>
  asSecret("oauthToken", JSON.stringify({ access_token: reveal(tokens.access_token), refresh_token: reveal(tokens.refresh_token), expires_at: tokens.expires_at, client_secret: reveal(tokens.client_secret) }));
