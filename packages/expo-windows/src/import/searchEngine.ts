import { exists, join, readJson, rowsOf, type ImportHost } from "./host";
import type { Result } from "./model";

type SearchEngine = NonNullable<Result["searchEngine"]>;
type Fields = Record<string, unknown>;

const PREFERENCES_LARGEST = 16 << 20;

const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

const positive = (value: unknown) => {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : undefined;
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
};

function chromiumEngine(name: unknown, keyword: unknown, url: unknown, prepopulateId: unknown): SearchEngine | undefined {
  const template = nonEmpty(url)?.replace(/\{searchTerms\?\}/g, "{searchTerms}");
  if (!template?.includes("{searchTerms}")) return undefined;
  const id = positive(prepopulateId);
  return { name: nonEmpty(name) ?? "", keyword: nonEmpty(keyword) ?? "", url: template, ...(id ? { prepopulateId: id } : {}) };
}

function chosenGuid(prefs: Fields): string | undefined {
  const provider = isFields(prefs.default_search_provider) ? prefs.default_search_provider : {};
  return nonEmpty(provider.guid) ?? nonEmpty(provider.synced_guid);
}

function selectedTemplate(prefs: Fields): SearchEngine | undefined {
  const provider = isFields(prefs.default_search_provider_data) ? prefs.default_search_provider_data : {};
  const data = isFields(provider.template_url_data) ? provider.template_url_data : undefined;
  return data && chromiumEngine(data.short_name, data.keyword, data.url, data.prepopulate_id);
}

async function keywordRow(host: ImportHost, profile: string, guid: string): Promise<SearchEngine | undefined> {
  if (!(await exists(host, profile, "Web Data"))) return undefined;
  const answer = await host.query(join(profile, "Web Data"), [{ sql: "SELECT short_name, keyword, url, prepopulate_id FROM keywords WHERE sync_guid = ?", args: [guid], limit: 1 }]);
  if (!("results" in answer) || answer.results[0]?.error) return undefined;
  const row = rowsOf(answer.results[0])[0];
  return row && chromiumEngine(row.text("short_name"), row.text("keyword"), row.text("url"), row.int("prepopulate_id"));
}

export async function readSearchEngine(host: ImportHost, profile: string): Promise<SearchEngine | undefined> {
  const prefs = await readJson(host, join(profile, "Preferences"), PREFERENCES_LARGEST);
  if (!isFields(prefs)) return undefined;
  const guid = chosenGuid(prefs);
  const chosen = guid ? await keywordRow(host, profile, guid).catch(() => undefined) : undefined;
  return chosen ?? selectedTemplate(prefs);
}
