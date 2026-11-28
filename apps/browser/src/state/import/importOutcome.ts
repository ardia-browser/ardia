import { orWarn } from "../../lib/fallback";
import { engineProfile } from "../browser/model";
import { useBrowser } from "../browser/store";
import { listPasswords } from "../site/passwords";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { noteConflictsResolved, noteMultiImport, notePasswordsKeptExisting, notePasswordsNotSaved } from "../telemetry/importRuns";
import { emptyCounts, saveLogins, type Credential, type ImportCounts, type ImportedExtension } from "./apply";
import { finishImport, importNow, patchImport, showAfterDoneDelay, type ConflictChoiceSet, type ImportFailure, type SourceOutcome, type SourceTally } from "./flow";
import { listFoundExtensions } from "./listedExtensions";
import {
  changedChoices,
  choicesFor,
  planLogins,
  resolutionOf,
  resolvedLogins,
  sameOriginKey,
  type CollectedLogin,
  type ConflictPick,
  type LoginPlan,
  type LoginToSave,
} from "./passwordConflicts";
import { adoptImportedEngine } from "./searchEngine";

export type HeldLogins = { profileId: string; credentials: readonly Credential[] }[];

const collected: CollectedLogin[] = [];
let unresolvedRun: { outcomes: SourceOutcome[]; plan: LoginPlan; signal: AbortSignal; token: number } | null = null;
let conflictTokens = 0;

export function collectLogins(browserId: string, consent: ConsentToken | null, held: HeldLogins) {
  for (const { profileId, credentials } of held) for (const credential of credentials) collected.push({ browserId, profileId, credential, consent });
}

export function forgetCollectedLogins() {
  collected.length = 0;
  unresolvedRun = null;
}

const dismissBookmarksOffer = (counts: ImportCounts) => {
  if (counts.bookmarks > 0) useBrowser.getState().updateSettings({ bookmarksImportDismissed: true });
};

export async function finishSource(outcome: SourceOutcome, consent: ConsentToken | null, signal: AbortSignal) {
  dismissBookmarksOffer(outcome.counts);
  const listing = await listFoundExtensions(outcome.extensions.groups, consent).catch(orWarn(null));
  if (signal.aborted) return;
  const engine = adoptImportedEngine(outcome.source, outcome.engines, consent);
  finishImport(signal, {
    counts: outcome.counts,
    failures: outcome.failures,
    notes: outcome.notes,
    extensions: { profileId: outcome.extensions.profileId, list: outcome.extensions.found, opened: false, listing },
    searchEngine: engine?.notice ?? undefined,
  });
}

const runConsent = (outcomes: SourceOutcome[]): ConsentToken | null =>
  outcomes.length && outcomes.every((o) => o.consent === outcomes[0]!.consent) ? outcomes[0]!.consent : null;

export async function finishRun(outcomes: SourceOutcome[], signal: AbortSignal) {
  const plan = planLogins(collected.splice(0), outcomes.map((o) => o.source.id), (profileId) => engineProfile(useBrowser.getState(), profileId));
  noteMultiImport({ browsers: outcomes.length, skipped: outcomes.filter((o) => o.skipped).length, merged: plan.merged, conflicts: plan.conflicts.length }, runConsent(outcomes));
  if (!plan.conflicts.length) return completeRun(outcomes, resolvedLogins(plan, {}), signal);
  const token = ++conflictTokens;
  unresolvedRun = { outcomes, plan, signal, token };
  const none: ConflictChoiceSet = { choices: {}, base: {} };
  showAfterDoneDelay(signal, { name: "conflicts", token, conflicts: plan.conflicts, pick: "newest", custom: null, view: "summary", draft: none, filter: "", saving: false });
}

const adoptable = (o: SourceOutcome) => !o.skipped && (o.source.family === "chromium" || o.source.family === "arc") && o.engines.length > 0;

function addCounts(into: ImportCounts, from: ImportCounts) {
  for (const k of Object.keys(into) as (keyof ImportCounts)[]) into[k] += from[k];
}

const KEPT_EXISTING = (n: number) =>
  `${n === 1 ? "1 password wasn't" : `${n} passwords weren't`} changed: Ardia already has a different one saved for ${n === 1 ? "that account" : "those accounts"}.`;

type SaveTally = { browserId: string; consent: ConsentToken | null; saved: number; keptExisting: number; failed: number };

async function savedAccounts(profileIds: readonly string[]): Promise<Map<string, Set<string> | null>> {
  const lists = await Promise.all(
    profileIds.map(async (profileId) => {
      const list = await listPasswords(engineProfile(useBrowser.getState(), profileId)).catch(orWarn(null));
      return [profileId, list ? new Set(list.map((p) => JSON.stringify([sameOriginKey(p.origin), p.username]))) : null] as const;
    }),
  );
  return new Map(lists);
}

async function saveRunLogins(outcomes: SourceOutcome[], logins: LoginToSave[], signal: AbortSignal): Promise<SaveTally[]> {
  const tallies: SaveTally[] = [];
  const tallyOf = (browserId: string, consent: ConsentToken | null) => {
    const found = tallies.find((t) => t.browserId === browserId && t.consent === consent);
    if (found) return found;
    const made = { browserId, consent, saved: 0, keptExisting: 0, failed: 0 };
    tallies.push(made);
    return made;
  };
  const results = await saveLogins(logins, signal);
  const refused = logins.filter((_, i) => results[i] === "refused");
  const accounts = refused.length ? await savedAccounts([...new Set(refused.map((l) => l.profileId))]) : new Map<string, Set<string> | null>();
  logins.forEach((l, i) => {
    const tally = tallyOf(l.browserId, l.consent);
    const result = results[i];
    if (result === "saved") tally.saved += 1;
    else if (result === "refused" && accounts.get(l.profileId)?.has(JSON.stringify([sameOriginKey(l.origin), l.username]))) tally.keptExisting += 1;
    else if (result) tally.failed += 1;
  });
  for (const o of outcomes) {
    const tally = tallyOf(o.source.id, o.consent);
    tally.keptExisting += o.passwordsWritten.keptExisting;
    tally.failed += o.passwordsWritten.failed;
  }
  for (const t of tallies) {
    notePasswordsKeptExisting(t.keptExisting, t.consent);
    notePasswordsNotSaved(t.failed, t.consent);
  }
  return tallies;
}

async function completeRun(outcomes: SourceOutcome[], logins: LoginToSave[], signal: AbortSignal) {
  const saves = await saveRunLogins(outcomes, logins, signal);
  if (signal.aborted) return;
  const keptExisting = saves.reduce((n, t) => n + t.keptExisting, 0);
  const consent = runConsent(outcomes);
  const imported = outcomes.filter((o) => !o.skipped);
  const tallies: SourceTally[] = imported.map((o) => ({ id: o.source.id, name: o.source.name, counts: { ...o.counts } }));
  for (const s of saves) {
    const tally = tallies.find((t) => t.id === s.browserId);
    if (tally) tally.counts.passwords += s.saved;
  }
  const total = emptyCounts();
  for (const t of tallies) addCounts(total, t.counts);
  dismissBookmarksOffer(total);
  const listing = await listFoundExtensions(imported.flatMap((o) => o.extensions.groups), consent).catch(orWarn(null));
  if (signal.aborted) return;
  const offering = imported.find((o) => adoptable(o) && o.engines.some((e) => e.engine)) ?? imported.find(adoptable);
  const engine = offering ? adoptImportedEngine(offering.source, offering.engines, offering.consent) : null;
  const found = new Map<string, ImportedExtension>();
  for (const o of imported) for (const e of o.extensions.found) if (!found.has(e.id)) found.set(e.id, e);
  const failures: ImportFailure[] = imported.flatMap((o) => o.failures.map((f) => ({ ...f, browser: o.source.name })));
  for (const o of imported) {
    const unsaved = saves.some((s) => s.browserId === o.source.id && s.failed > 0);
    if (unsaved && !failures.some((f) => f.browser === o.source.name && f.kind === "passwords")) failures.push({ kind: "passwords", profiles: [], browser: o.source.name });
  }
  const notes = [
    ...outcomes.filter((o) => o.skipped).map((o) => `${o.source.name} was skipped.`),
    ...imported.flatMap((o) => o.notes.map((n) => `${o.source.name}: ${n}`)),
    ...(keptExisting ? [KEPT_EXISTING(keptExisting)] : []),
  ];
  finishImport(signal, {
    counts: total,
    failures,
    notes,
    extensions: { profileId: imported.map((o) => o.extensions.profileId).find(Boolean) ?? "", list: [...found.values()], opened: false, listing },
    searchEngine: engine?.notice ?? undefined,
    sources: tallies,
    ...(engine?.notice && offering ? { engineFrom: offering.source.name } : {}),
  });
}

const conflictStep = (token?: number) => {
  const { step } = importNow();
  return step.name === "conflicts" && (token === undefined || step.token === token) ? step : null;
};

type ConflictStep = NonNullable<ReturnType<typeof conflictStep>>;

export function currentChoices(step: ConflictStep): Record<string, string> {
  if (step.view === "list") return step.draft.choices;
  if (step.pick === "custom" && step.custom) return step.custom.choices;
  return choicesFor(step.conflicts, step.pick);
}

export const handChanges = (set: ConflictChoiceSet | null) => (set ? changedChoices(set.base, set.choices) : 0);

export function pickConflictVersions(pick: ConflictPick, token: number) {
  const step = conflictStep(token);
  if (!step || step.saving || (pick === "custom" && !step.custom)) return;
  patchImport({ step: { ...step, pick, view: "summary" } });
}

export function openConflictList(token: number) {
  const step = conflictStep(token);
  if (!step || step.saving || step.view === "list") return;
  const choices = currentChoices(step);
  const base = step.pick === "custom" && step.custom ? step.custom.base : choices;
  patchImport({ step: { ...step, view: "list", draft: { choices, base }, filter: "" } });
}

export function setConflictFilter(filter: string, token: number) {
  const step = conflictStep(token);
  if (step?.view === "list") patchImport({ step: { ...step, filter } });
}

export function chooseConflictVersion(id: string, browserId: string, token: number) {
  const step = conflictStep(token);
  const conflict = step?.conflicts.find((c) => c.id === id);
  if (!step || step.view !== "list" || !conflict?.versions.some((v) => v.browserId === browserId)) return;
  patchImport({ step: { ...step, draft: { ...step.draft, choices: { ...step.draft.choices, [id]: browserId } } } });
}

export function chooseAllConflicts(browserId: string, token: number) {
  const step = conflictStep(token);
  if (!step || step.view !== "list") return;
  const choices = Object.fromEntries(step.conflicts.map((c) => [c.id, c.versions.some((v) => v.browserId === browserId) ? browserId : step.draft.choices[c.id]!]));
  patchImport({ step: { ...step, draft: { ...step.draft, choices } } });
}

export function closeConflictList(token: number) {
  const step = conflictStep(token);
  if (!step || step.view !== "list") return;
  patchImport({ step: { ...step, view: "summary", pick: "custom", custom: step.draft } });
}

export async function importChosenPasswords(token: number) {
  const step = conflictStep();
  if (!step || step.saving || !unresolvedRun || step.token !== token || unresolvedRun.token !== token) return;
  const custom = step.view === "list" ? step.draft : step.pick === "custom" ? step.custom : null;
  const pick: ConflictPick = step.view === "list" ? "custom" : step.pick;
  const choices = currentChoices(step);
  const consent = consentToken();
  const { outcomes, plan, signal } = unresolvedRun;
  unresolvedRun = null;
  patchImport({ step: { ...step, saving: true } });
  noteConflictsResolved({ resolution: resolutionOf(pick), changedByHand: handChanges(custom) }, consent);
  await completeRun(outcomes, resolvedLogins(plan, choices), signal);
}
