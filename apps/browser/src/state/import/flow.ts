import { create } from "zustand";
import { IMPORT_WINDOW_ID, takePreferredImportSource } from "../settings/settingsWindows";
import { requestWindowClose } from "../windows/windowClose";
import { defaultTarget, openInWebStore, type BrowserProfile, type BrowserSource, type ImportCounts, type ImportedExtension, type ImportedSearchEngine, type ImportKind } from "./apply";
import type { ExtensionGroup, ExtensionListing } from "./extensionListing";
import { importModule } from "./importApi";
import type { ConflictPick, PasswordConflict } from "./passwordConflicts";
import type { ConsentToken } from "../telemetry/choice";
import { endTurn, liveTurn } from "./importTurn";

export type KindStatus = "pending" | "active" | "done" | "failed";
type ImportStatus = Partial<Record<ImportKind, KindStatus>>;
export type ImportFailure = { kind: ImportKind; profiles: string[]; browser?: string };
type FoundExtensions = { profileId: string; list: ImportedExtension[]; opened: boolean; listing: ExtensionListing | null };
export type EngineNotice = { name: string; offered: boolean; engine: ImportedSearchEngine };
export type SourceTally = { id: string; name: string; counts: ImportCounts };
export type ImportResults = {
  counts: ImportCounts;
  failures: ImportFailure[];
  notes: string[];
  extensions: FoundExtensions;
  searchEngine?: EngineNotice;
  sources?: SourceTally[];
  engineFrom?: string;
};

export type SourceOutcome = {
  source: Pick<BrowserSource, "id" | "name" | "family">;
  counts: ImportCounts;
  failures: ImportFailure[];
  notes: string[];
  extensions: { profileId: string; found: ImportedExtension[]; groups: ExtensionGroup[] };
  engines: { profile: BrowserProfile; engine?: ImportedSearchEngine }[];
  skipped: boolean;
  consent: ConsentToken | null;
  passwordsWritten: { keptExisting: number; failed: number };
};

export type ImportRun = { ids: string[]; at: number; chosen: ImportKind[]; offered: ImportKind[]; outcomes: SourceOutcome[] };

export type ConflictChoiceSet = { choices: Record<string, string>; base: Record<string, string> };
export type ConflictsView = "summary" | "list";

type ImportStep =
  | { name: "loading" }
  | { name: "choose"; error: string | null }
  | { name: "profiles" }
  | { name: "access" }
  | { name: "safari"; error: string | null }
  | { name: "unlock"; unlocking: boolean; error: string | null }
  | { name: "progress"; status: ImportStatus; preparing: number }
  | {
      name: "conflicts";
      token: number;
      conflicts: PasswordConflict[];
      pick: ConflictPick;
      custom: ConflictChoiceSet | null;
      view: ConflictsView;
      draft: ConflictChoiceSet;
      filter: string;
      saving: boolean;
    }
  | ({ name: "done" } & ImportResults);
export type ImportStepName = ImportStep["name"];

export type ImportFlow = {
  browsers: BrowserSource[];
  picked: string[];
  run: ImportRun | null;
  turn: number | null;
  source: BrowserSource | null;
  sourceProfiles: string[];
  spaces: string[];
  kinds: ReadonlySet<ImportKind>;
  target: string;
  safariCookies: boolean;
  fullDiskAccess: boolean;
  step: ImportStep;
};

export const IMPORT_KINDS: ImportKind[] = ["bookmarks", "history", "passwords", "cookies", "autofill", "tabs", "spaces", "pinnedTabs", "favorites", "linkRules", "archive"];
export const ENCRYPTED_KINDS: ImportKind[] = ["passwords", "cookies", "autofill"];
export const APP_TAB_KINDS: ImportKind[] = ["tabs", "pinnedTabs"];
export const DIA_SIDEBAR_KINDS: ImportKind[] = ["tabs", "pinnedTabs", "favorites"];
export const ARC_ONCE_KINDS: ImportKind[] = ["linkRules", "archive"];
export const NO_EXTENSIONS: FoundExtensions = { profileId: "", list: [], opened: false, listing: null };

const freshFlow = (target: string): ImportFlow => ({
  browsers: [],
  picked: [],
  run: null,
  turn: null,
  source: null,
  sourceProfiles: [],
  spaces: [],
  kinds: new Set(),
  target,
  safariCookies: true,
  fullDiskAccess: false,
  step: { name: "loading" },
});

export const useImportFlow = create<ImportFlow>()(() => freshFlow(""));

export const importNow = () => useImportFlow.getState();
export const patchImport = (patch: Partial<ImportFlow>) => useImportFlow.setState(patch);

let session = new AbortController();
let doneDelay = 0;

export const importSignal = () => session.signal;

export const importsBySpaces = (source: BrowserSource | null) => !!source?.sidebar;
export const spacesOf = (source: BrowserSource | null) =>
  (source?.profiles ?? []).flatMap((p) => (p.spaces ?? []).map((sp) => ({ ...sp, profileId: p.id })));
export const spacelessProfiles = (source: BrowserSource | null) => (source?.profiles ?? []).filter((p) => !p.spaces?.length);

export const waitsForAccess = ({ step, fullDiskAccess }: ImportFlow) => (step.name === "safari" && !fullDiskAccess) || step.name === "access";

export const inRun = (flow: Pick<ImportFlow, "run">) => (flow.run?.ids.length ?? 0) > 1;
export const runStepLabel = ({ run, source }: Pick<ImportFlow, "run" | "source">) =>
  run && run.ids.length > 1 && source ? `${run.at + 1} of ${run.ids.length}: ${source.name}` : undefined;
export const canGoBackToChoose = (flow: Pick<ImportFlow, "run">) => !inRun(flow) || (flow.run!.at === 0 && !flow.run!.outcomes.length);

export function startImport(delayBeforeDone: number): () => void {
  session.abort();
  const own = (session = new AbortController());
  doneDelay = delayBeforeDone;
  useImportFlow.setState(freshFlow(defaultTarget()), true);
  const api = importModule();
  void api.listBrowsers().then(
    (list) => {
      if (own.signal.aborted) return;
      patchImport({ browsers: list });
      const preferred = takePreferredImportSource();
      const first = list.find((b) => b.id === preferred) ?? list.find((b) => !b.needsFullDiskAccess && !b.requiresExport) ?? list[0];
      if (first) showSource(first);
      else patchImport({ step: { name: "choose", error: null } });
    },
    () => {
      if (!own.signal.aborted) patchImport({ step: { name: "choose", error: null } });
    },
  );
  return () => {
    own.abort();
    api.forgetUnlockedKeys();
  };
}

const availableKinds = (b: BrowserSource): ImportKind[] => (b.requiresExport ? ["bookmarks", "history", "passwords"] : b.profiles.flatMap((p) => p.available));
export const kindsShownFor = (b: BrowserSource) => !b.requiresExport && !b.needsFullDiskAccess;
export const kindsOffered = (list: BrowserSource[]): ImportKind[] => [...new Set(list.filter(kindsShownFor).flatMap((b) => b.profiles.flatMap((p) => p.available)))];

function sourceFields(b: BrowserSource, kinds: Iterable<ImportKind>): Partial<ImportFlow> {
  const defaults = b.profiles.filter((p) => p.isDefault);
  const spaceProfiles = b.sidebar === "arc" || !defaults.length ? b.profiles : defaults;
  return {
    source: b,
    sourceProfiles: (b.asksAppForTabs ? b.profiles : defaults.length ? defaults : b.profiles.slice(0, 1)).map((p) => p.id),
    spaces: spaceProfiles.flatMap((p) => p.spaces ?? []).map((sp) => sp.id),
    kinds: new Set(kinds),
    ...(b.family === "safari" ? { fullDiskAccess: importModule().safariHasFullDiskAccess() } : {}),
  };
}

export const choosing = () => {
  const flow = importNow();
  return flow.step.name === "choose" && !flow.run && !liveTurn();
};

export function showSource(b: BrowserSource) {
  patchImport({ ...sourceFields(b, availableKinds(b)), picked: [b.id], run: null, step: { name: "choose", error: null } });
}

export function chooseSource(b: BrowserSource) {
  if (choosing()) showSource(b);
}

export const pickedBrowsers = ({ browsers, picked }: Pick<ImportFlow, "browsers" | "picked">) => browsers.filter((b) => picked.includes(b.id));

export function pickSources(ids: readonly string[]) {
  if (!choosing()) return;
  const flow = importNow();
  const next = flow.browsers.filter((b) => ids.includes(b.id));
  if (next.length === 1) return chooseSource(next[0]!);
  if (!next.length) return patchImport({ picked: [], run: null, source: null, sourceProfiles: [], spaces: [], kinds: new Set(), step: { name: "choose", error: null } });
  const before = new Set(kindsOffered(pickedBrowsers(flow)));
  const kinds = kindsOffered(next).filter((k) => !before.has(k) || flow.kinds.has(k));
  patchImport({ ...sourceFields(next[0]!, kinds), picked: next.map((b) => b.id), run: null, step: { name: "choose", error: null } });
}

export function toggleSource(b: BrowserSource) {
  if (!choosing()) return;
  const { picked } = importNow();
  pickSources(picked.includes(b.id) ? picked.filter((id) => id !== b.id) : [...picked, b.id]);
}

export function startRun(): boolean {
  const flow = importNow();
  const offered = kindsOffered(pickedBrowsers(flow));
  const ids = pickedBrowsers(flow)
    .filter((b) => !kindsShownFor(b) || b.profiles.some((p) => p.available.some((k) => flow.kinds.has(k))))
    .map((b) => b.id);
  if (!ids.length) return false;
  patchImport({ run: { ids, at: 0, chosen: [...flow.kinds], offered, outcomes: [] } });
  return true;
}

export function takeTurn(b: BrowserSource) {
  const { run } = importNow();
  const kinds = run ? availableKinds(b).filter((k) => !run.offered.includes(k) || run.chosen.includes(k)) : availableKinds(b);
  patchImport(sourceFields(b, kinds));
}

const toggled = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));

const onStep = (token: number | null, ...steps: ImportStepName[]) => {
  const flow = importNow();
  return flow.turn === token && steps.includes(flow.step.name);
};

export function toggleImportKind(kind: ImportKind, on: boolean) {
  if (!choosing()) return;
  const kinds = new Set(importNow().kinds);
  if (on) kinds.add(kind);
  else kinds.delete(kind);
  patchImport({ kinds });
}

export const setImportKinds = (kinds: Iterable<ImportKind>) => patchImport({ kinds: new Set(kinds) });

export function toggleSourceProfile(id: string, on: boolean, token: number | null) {
  if (onStep(token, "profiles")) patchImport({ sourceProfiles: toggled(importNow().sourceProfiles, id, on) });
}

export function toggleImportSpace(id: string, on: boolean, token: number | null) {
  if (onStep(token, "profiles")) patchImport({ spaces: toggled(importNow().spaces, id, on) });
}

export function setImportTarget(target: string, token: number | null) {
  if (onStep(token, "choose", "profiles", "safari") && !inRun(importNow())) patchImport({ target });
}

export function setSafariCookies(safariCookies: boolean, token: number | null) {
  if (onStep(token, "safari")) patchImport({ safariCookies });
}

const BACK_TO_CHOOSE: ImportStepName[] = ["profiles", "unlock", "safari", "access"];

export function backTo(name: "choose" | "profiles", token: number | null) {
  const flow = importNow();
  if (flow.turn !== token) return;
  if (name === "profiles") {
    if (flow.step.name === "unlock") patchImport({ step: { name } });
    return;
  }
  const fromDone = flow.step.name === "done";
  if (!fromDone && !(BACK_TO_CHOOSE.includes(flow.step.name) && canGoBackToChoose(flow))) return;
  endTurn();
  const first = flow.run ? pickedBrowsers(flow)[0] : undefined;
  patchImport({
    ...(flow.run && first ? { ...sourceFields(first, flow.run.chosen), run: null } : { run: null }),
    turn: null,
    step: { name, error: null },
  });
}
export const closeImport = () => requestWindowClose(IMPORT_WINDOW_ID);
export const cancelImport = () => requestWindowClose(IMPORT_WINDOW_ID, () => session.abort());

export function openFoundExtensions() {
  const { step, target } = importNow();
  if (step.name !== "done") return;
  openInWebStore(step.extensions.profileId || target, step.extensions.list.map((e) => e.webStoreUrl));
  patchImport({ step: { ...step, extensions: { ...step.extensions, opened: true } } });
}

export function updateStatus(signal: AbortSignal, change: (status: ImportStatus) => ImportStatus) {
  const { step } = importNow();
  if (!signal.aborted && step.name === "progress") patchImport({ step: { ...step, status: change(step.status) } });
}

export function startProgress(status: ImportStatus, preparing: number) {
  patchImport({ step: { name: "progress", status, preparing } });
}

export function showAfterDoneDelay(signal: AbortSignal, step: ImportStep) {
  setTimeout(() => {
    if (!signal.aborted) patchImport({ step });
  }, doneDelay);
}

export const finishImport = (signal: AbortSignal, results: ImportResults) => showAfterDoneDelay(signal, { name: "done", ...results });

export const pauseForDoneDelay = () => new Promise<void>((resolve) => setTimeout(resolve, doneDelay));

