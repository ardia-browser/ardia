import { hostOf, searchUrlFor } from "./omnibox.ts";

export type SearchEngine = {
  id: string;
  name: string;
  keyword: string;
  url: string;
  suggestUrl?: string;
  custom?: boolean;
  extension?: { id: string; name: string };
};

export type CustomSearchEngine = { id: string; name: string; keyword: string; url: string };

export type ExtensionSearchEngine = {
  profile: string;
  extensionId: string;
  extensionName: string;
  name: string;
  keyword: string;
  url: string;
  suggestUrl?: string;
  isDefault: boolean;
};

export const BUILT_IN_ENGINES: readonly SearchEngine[] = [
  {
    id: "google",
    name: "Google",
    keyword: "google.com",
    url: "https://www.google.com/search?q=%s",
    suggestUrl: "https://www.google.com/complete/search?client=chrome&q=%s",
  },
  { id: "bing", name: "Bing", keyword: "bing.com", url: "https://www.bing.com/search?q=%s", suggestUrl: "https://api.bing.com/osjson.aspx?query=%s" },
  {
    id: "duckduckgo",
    name: "DuckDuckGo",
    keyword: "duckduckgo.com",
    url: "https://duckduckgo.com/?q=%s",
    suggestUrl: "https://duckduckgo.com/ac/?q=%s&type=list",
  },
  { id: "perplexity", name: "Perplexity", keyword: "perplexity.ai", url: "https://www.perplexity.ai/search?q=%s" },
  { id: "chatgpt", name: "ChatGPT", keyword: "chatgpt.com", url: "https://chatgpt.com/?q=%s" },
  { id: "claude", name: "Claude", keyword: "claude.ai", url: "https://claude.ai/new?q=%s" },
  {
    id: "ecosia",
    name: "Ecosia",
    keyword: "ecosia.org",
    url: "https://www.ecosia.org/search?q=%s",
    suggestUrl: "https://ac.ecosia.org/autocomplete?q=%s&type=list",
  },
  {
    id: "brave",
    name: "Brave Search",
    keyword: "search.brave.com",
    url: "https://search.brave.com/search?q=%s",
    suggestUrl: "https://search.brave.com/api/suggest?q=%s",
  },
  { id: "kagi", name: "Kagi", keyword: "kagi.com", url: "https://kagi.com/search?q=%s" },
  {
    id: "startpage",
    name: "Startpage",
    keyword: "startpage.com",
    url: "https://www.startpage.com/do/search?q=%s",
    suggestUrl: "https://www.startpage.com/osuggestions?q=%s",
  },
  {
    id: "yahoo",
    name: "Yahoo",
    keyword: "yahoo.com",
    url: "https://search.yahoo.com/search?p=%s",
    suggestUrl: "https://search.yahoo.com/sugg/ff?output=fxjson&command=%s",
  },
  {
    id: "baidu",
    name: "Baidu",
    keyword: "baidu.com",
    url: "https://www.baidu.com/s?wd=%s",
    suggestUrl: "https://www.baidu.com/su?action=opensearch&ie=utf-8&wd=%s",
  },
  {
    id: "yandex",
    name: "Yandex",
    keyword: "yandex.com",
    url: "https://yandex.com/search/?text=%s",
    suggestUrl: "https://suggest.yandex.com/suggest-ff.cgi?part=%s",
  },
];

export const validSearchTemplate = (url: unknown): url is string => typeof url === "string" && /^https?:\/\/[^/?#\s]+/i.test(url) && url.includes("%s");

export function customEngineFrom(raw: unknown): CustomSearchEngine | null {
  if (!raw || typeof raw !== "object") return null;
  const { id, name, keyword, url } = raw as Record<string, unknown>;
  if (typeof id !== "string" || typeof name !== "string" || typeof keyword !== "string" || !validSearchTemplate(url)) return null;
  return { id, name, keyword, url };
}

export const customEnginesFrom = (raw: unknown): CustomSearchEngine[] =>
  Array.isArray(raw) ? raw.flatMap((e) => customEngineFrom(e) ?? []) : [];

export function allEngines(custom: readonly CustomSearchEngine[] = [], extension: readonly ExtensionSearchEngine[] = []): SearchEngine[] {
  const engines: SearchEngine[] = [...BUILT_IN_ENGINES, ...customEnginesFrom(custom).map((e) => ({ ...e, custom: true }))];
  const seen = new Set<string>();
  for (const e of extension) {
    if (seen.has(e.extensionId)) continue;
    seen.add(e.extensionId);
    engines.push({
      id: extensionEngineId(e.extensionId),
      name: e.name,
      keyword: e.keyword,
      url: e.url,
      suggestUrl: e.suggestUrl || undefined,
      extension: { id: e.extensionId, name: e.extensionName },
    });
  }
  return engines;
}

export const extensionEngineId = (extensionId: string) => `extension:${extensionId}`;

export function controllingExtensionEngine(extension: readonly ExtensionSearchEngine[]): ExtensionSearchEngine | undefined {
  return extension.find((e) => e.isDefault);
}

export function engineById(engines: readonly SearchEngine[], id: string | undefined): SearchEngine {
  return engines.find((e) => e.id === id) ?? BUILT_IN_ENGINES[0]!;
}

export const searchUrl = (engine: Pick<SearchEngine, "url">, query: string) => searchUrlFor(engine.url, query);

export const MAX_SUGGEST_QUERY = 200;
const MAX_SUGGEST_URL = 2048;

export const suggestRequestUrl = (engine: SearchEngine, query: string) => {
  const trimmed = query.trim();
  if (!engine.suggestUrl || engine.custom || !trimmed || trimmed.length > MAX_SUGGEST_QUERY) return null;
  const url = searchUrlFor(engine.suggestUrl, trimmed);
  return url.length <= MAX_SUGGEST_URL ? url : null;
};

export const engineHost = (engine: Pick<SearchEngine, "url">) => hostOf(engine.url.replace(/%s/g, "q"));

const NOT_QUERIES = new Set(["NAVIGATION", "PERSONALIZED_NAVIGATION", "CALCULATOR"]);
const SITES = new Set(["NAVIGATION", "PERSONALIZED_NAVIGATION"]);

export type RemoteSite = { url: string; title: string };
export type RemoteSuggestions = { queries: string[]; sites: RemoteSite[] };

export const suggestReplyJson = (text: string): unknown => JSON.parse(text.replace(/^\)\]\}'\s*/, ""));

export const isSuggestReplyShape = (body: unknown): body is [unknown, unknown[], ...unknown[]] =>
  Array.isArray(body) && Array.isArray(body[1]);

export function parseRemoteSuggestions(body: unknown): RemoteSuggestions {
  if (!isSuggestReplyShape(body)) return { queries: [], sites: [] };
  const extras = body[4] as { "google:suggesttype"?: unknown } | undefined;
  const types = Array.isArray(extras?.["google:suggesttype"]) ? (extras["google:suggesttype"] as unknown[]) : [];
  const titles = Array.isArray(body[2]) ? (body[2] as unknown[]) : [];
  const queries: string[] = [];
  const sites: RemoteSite[] = [];
  (body[1] as unknown[]).forEach((s, i) => {
    if (typeof s !== "string" || s.trim() === "") return;
    const type = String(types[i]);
    if (SITES.has(type)) {
      if (/^https?:\/\/[^\s/?#]+/i.test(s.trim())) sites.push({ url: s.trim(), title: typeof titles[i] === "string" ? (titles[i] as string).trim() : "" });
    } else if (!NOT_QUERIES.has(type)) queries.push(s.trim());
  });
  return { queries, sites };
}

export const parseSuggestions = (body: unknown): string[] => parseRemoteSuggestions(body).queries;

export type EngineInput = { name: string; keyword: string; url: string };

export function validateEngine(input: EngineInput, engines: readonly SearchEngine[], ignoreId?: string): string | null {
  const name = input.name.trim();
  const keyword = input.keyword.trim().toLowerCase();
  const url = input.url.trim();
  if (!name) return "Enter a name.";
  if (!keyword) return "Enter a shortcut.";
  if (/\s/.test(keyword)) return "The shortcut can't contain spaces.";
  if (!/^https?:\/\/[^/?#\s]+/i.test(url)) return "Enter a URL that starts with http:// or https://.";
  if (!url.includes("%s")) return "The URL must contain %s where the search terms go.";
  if (engines.some((e) => e.id !== ignoreId && e.keyword.toLowerCase() === keyword)) return `“${keyword}” is already used by another search engine.`;
  return null;
}

export function makeCustomEngine(input: EngineInput, id: string): CustomSearchEngine {
  return { id, name: input.name.trim(), keyword: input.keyword.trim().toLowerCase(), url: input.url.trim() };
}
