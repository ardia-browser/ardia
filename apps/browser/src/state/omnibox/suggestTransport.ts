import { BUILT_IN_ENGINES, type FetchLike, type SearchEngine } from "@ardia/core";
import { liveExtensionSearchEngines } from "../extensions/searchEngines";
import { fetchSearchSuggestions, stopSearchSuggestions } from "../../platform/search";
import { noteSearchSuggest } from "../telemetry/track";
import { consentNow } from "../telemetry/client";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { useBrowser } from "../browser/store";

const BLOCKED_STATUSES = new Set([403, 429]);
const MAX_SUGGEST_URL_LENGTH = 2048;
let nextRequestId = 1;

export const remoteSuggestionsAllowed = (profileId: string) => !isIncognitoProfile(profileId);

export const suggestProfileKey = (profileId: string) => engineProfile(useBrowser.getState(), profileId);

const originOf = (url: string) => {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password ? parsed.origin : null;
  } catch {
    return null;
  }
};

function trustedSuggestTemplate(engine: SearchEngine | undefined, profile: string): string | null {
  if (!engine) return null;
  const builtIn = BUILT_IN_ENGINES.find((e) => e.id === engine.id);
  if (builtIn) return builtIn.suggestUrl ?? null;
  const id = engine.extension?.id;
  const installed = id ? liveExtensionSearchEngines(profile).find((e) => e.extensionId === id) : undefined;
  return typeof installed?.suggestUrl === "string" ? installed.suggestUrl : null;
}

function suggestUrlAllowed(url: string, template: unknown): boolean {
  if (url.length > MAX_SUGGEST_URL_LENGTH || typeof template !== "string" || !template.includes("%s")) return false;
  const prefix = template.slice(0, template.indexOf("%s"));
  if (!/^https?:\/\/[^/?#\s]+[/?]/i.test(prefix) || !url.startsWith(prefix)) return false;
  const origin = originOf(url);
  return origin !== null && origin === originOf(template.replaceAll("%s", "q"));
}

export function browserSuggestFetch(profile: string): FetchLike {
  return async (url, { signal, engine }) => {
    if (!suggestUrlAllowed(url, trustedSuggestTemplate(engine, profile))) return { ok: false, text: async () => "" };
    const id = nextRequestId++;
    const consent = consentNow();
    const stop = () => void stopSearchSuggestions(profile, id).catch(() => {});
    signal.addEventListener("abort", stop, { once: true });
    try {
      const reply = await fetchSearchSuggestions(profile, url, id);
      if (reply.stopped || signal.aborted) throw new Error("suggestion request stopped");
      const blocked = BLOCKED_STATUSES.has(reply.status);
      noteSearchSuggest(reply.status === 200 ? "ok" : blocked ? "blocked" : "failed", consent);
      const body = reply.body ?? "";
      return { ok: reply.status === 200 && !!body, blocked, text: async () => body };
    } finally {
      signal.removeEventListener("abort", stop);
    }
  };
}
