import { BUILT_IN_ENGINES, engineById, hostOf, validateEngine, type EngineInput, type SearchEngine } from "@ardia/core";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import type { BrowserProfile, BrowserSource, ImportedSearchEngine } from "../../platform/importModule";
import { useBrowser } from "../browser/store";
import { useOnboarding } from "../onboarding/onboarding";
import { controllingSearchExtension, DEFAULT_SETTINGS, searchEngines } from "../settings/settings";
import { appScopeRecords } from "../sync/engine";
import { settingSyncedIn } from "../sync/settingsAdapter";
import type { ConsentToken } from "../telemetry/client";
import { noteSearchEngineOfferTaken } from "../telemetry/importRuns";
import { noteSearchEngineImport, type SearchEngineImportOutcome } from "../telemetry/searchEngineImports";
import { importNow, patchImport, type EngineNotice } from "./flow";
import { t } from "../../lib/uiLanguage";


export type ImportedEngineMatch = { id: string } | { custom: EngineInput } | null;

export type AdoptedEngine = { outcome: SearchEngineImportOutcome; notice: EngineNotice | null; changed: boolean };

type ProfileEngines = readonly { profile: BrowserProfile; engine?: ImportedSearchEngine }[];

export function chromiumTemplateUrl(template: string): string {
  return template
    .trim()
    .replace(/^\{google:baseURL\}/, "https://www.google.com/")
    .replace(/\{searchTerms\??\}/g, "%s")
    .replace(/\{(?:inputEncoding|outputEncoding)\}/g, t(`UTF-8`))
    .replace(/\{[^{}]*\}/g, "")
    .replace(/&{2,}/g, "&")
    .replace(/\?&/, "?")
    .replace(/[?&]+$/, "");
}

const comparableUrl = (url: string) => {
  const [, scheme, host, rest] = /^([a-z][a-z\d+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(url.trim()) ?? [];
  return scheme === undefined || host === undefined ? url.trim() : `${scheme.toLowerCase()}${host.toLowerCase().replace(/^www\./, "")}${rest ?? ""}`;
};

const sameUrl = (a: string, b: string) => comparableUrl(a) === comparableUrl(b);

const onHost = (host: string, engine: SearchEngine) => {
  const own = hostOf(engine.url.replace(/%s/g, "q"));
  return !!own && (host === own || host.endsWith(`.${own}`));
};

function customInput(engine: ImportedSearchEngine, url: string, engines: readonly SearchEngine[]): EngineInput | null {
  const host = hostOf(url.replace(/%s/g, "q"));
  const name = engine.name.trim() || host;
  for (const keyword of new Set([engine.keyword.trim().toLowerCase(), host].filter(Boolean))) {
    const input = { name, keyword, url };
    if (!validateEngine(input, engines)) return input;
  }
  return null;
}

export function matchImportedEngine(engine: ImportedSearchEngine, engines: readonly SearchEngine[]): ImportedEngineMatch {
  const url = chromiumTemplateUrl(engine.url);
  const keyword = engine.keyword.trim().toLowerCase();
  const host = hostOf(url.replace(/%s/g, "q"));
  const same = engines.find((e) => !e.extension && sameUrl(e.url, url));
  if (same) return { id: same.id };
  const named = BUILT_IN_ENGINES.find((e) => e.keyword === keyword && onHost(host, e));
  if (named) return { id: named.id };
  const prepopulated = engine.prepopulateId ? BUILT_IN_ENGINES.find((e) => onHost(host, e)) : undefined;
  if (prepopulated) return { id: prepopulated.id };
  const custom = customInput(engine, url, engines);
  return custom ? { custom } : null;
}

export function sourceEngine(profiles: ProfileEngines): ImportedSearchEngine | undefined {
  return (profiles.find((p) => p.profile.isDefault) ?? profiles[0])?.engine;
}

export function engineChosenByUser(): boolean {
  const { settings, settingsMeta } = useBrowser.getState();
  if (settingsMeta.chosen.includes("searchEngine") || settings.searchEngine !== DEFAULT_SETTINGS.searchEngine) return true;
  return settingSyncedIn(appScopeRecords(), "searchEngine");
}

function settingUpForTheFirstTime(): boolean {
  const { windowId, redo } = useOnboarding.getState();
  return windowId !== null && !redo;
}

const currentEngines = () => searchEngines(useBrowser.getState().settings);

const nameOf = (id: string) => engineById(currentEngines(), id).name;

function engineIdFor(match: NonNullable<ImportedEngineMatch>): string | null {
  if ("id" in match) return match.id;
  const made = useBrowser.getState().addCustomEngine(match.custom);
  return "error" in made ? null : made.id;
}

function adopt(engine: ImportedSearchEngine | undefined): AdoptedEngine {
  if (!engine) return { outcome: "source_default", notice: null, changed: false };
  const match = matchImportedEngine(engine, currentEngines());
  if (!match) return { outcome: "unusable", notice: null, changed: false };
  const outcome = "id" in match && BUILT_IN_ENGINES.some((e) => e.id === match.id) ? "built_in" : "custom";
  const { settings } = useBrowser.getState();
  if (controllingSearchExtension(settings)) return { outcome, notice: null, changed: false };
  const same = "id" in match && match.id === settings.searchEngine;
  if (engineChosenByUser() && !settingUpForTheFirstTime()) {
    return { outcome, notice: same ? null : { name: "id" in match ? nameOf(match.id) : match.custom.name, offered: true, engine }, changed: false };
  }
  const id = engineIdFor(match);
  if (!id) return { outcome: "unusable", notice: null, changed: false };
  useBrowser.getState().updateSettings({ searchEngine: id }, { inferred: true });
  return { outcome, notice: same ? null : { name: nameOf(id), offered: false, engine }, changed: !same };
}

export function adoptImportedEngine(source: Pick<BrowserSource, "id" | "family">, profiles: ProfileEngines, consent: ConsentToken | null): AdoptedEngine | null {
  if (!PLATFORM_FEATURES.readsSearchEngine || !profiles.length || (source.family !== "chromium" && source.family !== "arc")) return null;
  const adopted = adopt(sourceEngine(profiles));
  noteSearchEngineImport(source.id, adopted.outcome, adopted.changed, !!adopted.notice?.offered, consent);
  return adopted;
}

export function takeOfferedEngine() {
  const { step } = importNow();
  if (step.name !== "done" || !step.searchEngine?.offered || controllingSearchExtension(useBrowser.getState().settings)) return;
  const match = matchImportedEngine(step.searchEngine.engine, currentEngines());
  const id = match && engineIdFor(match);
  if (!id) return;
  useBrowser.getState().setSearchEngine(id);
  noteSearchEngineOfferTaken();
  patchImport({ step: { ...step, searchEngine: { ...step.searchEngine, name: nameOf(id), offered: false } } });
}
