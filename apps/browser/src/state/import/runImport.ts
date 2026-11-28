import { AppState } from "react-native";
import { orWarn } from "../../lib/fallback";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { emptyCounts, type BrowserSource, type ImportKind } from "./apply";
import {
  showSource,
  DIA_SIDEBAR_KINDS,
  ENCRYPTED_KINDS,
  importNow,
  IMPORT_KINDS,
  importSignal,
  importsBySpaces,
  inRun,
  patchImport,
  pauseForDoneDelay,
  spacesOf,
  startImport,
  startRun,
  takeTurn,
  waitsForAccess,
  type ImportStepName,
  type SourceOutcome,
} from "./flow";
import { importModule } from "./importApi";
import { collectLogins, finishRun, finishSource, forgetCollectedLogins, type HeldLogins } from "./importOutcome";
import { runImportJob } from "./importSource";
import { claimRead, claimSettle, endTurn, isLiveToken, liveTurn, ownsTurn, readingNow, releaseRead, startTurn as startTurnIn, whileOwned, type ImportTurn } from "./importTurn";
import { during } from "../app/jobActivity";

let runConsent: ConsentToken | null = null;

function startTurn(consent: ConsentToken | null): ImportTurn {
  const turn = startTurnIn(consent, importSignal());
  patchImport({ turn: turn.token });
  return turn;
}

export function turnFor(token: number | null, ...steps: ImportStepName[]): ImportTurn | null {
  const turn = liveTurn();
  return turn && isLiveToken(token) && turn.token === token && steps.includes(importNow().step.name) && !readingNow(turn) ? turn : null;
}

export function openImportSession(delayBeforeDone: number): () => void {
  forgetCollectedLogins();
  endTurn();
  runConsent = null;
  const stop = startImport(delayBeforeDone);
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active" && waitsForAccess(importNow())) void recheckAccess(importNow().turn);
  });
  return () => {
    stop();
    appState.remove();
    endTurn();
    forgetCollectedLogins();
  };
}

export async function recheckAccess(token: number | null) {
  const { step } = importNow();
  if (step.name === "safari") return patchImport({ fullDiskAccess: importModule().safariHasFullDiskAccess() });
  const turn = turnFor(token, "access");
  if (!turn) return;
  await whileOwned(turn, importModule().listBrowsers(), (list) => {
    const flow = importNow();
    if (flow.step.name !== "access") return;
    const several = inRun(flow);
    patchImport({ browsers: several ? flow.browsers.map((b) => list.find((x) => x.id === b.id) ?? b) : list });
    const updated = list.find((b) => b.id === flow.source?.id);
    if (!updated || updated.needsFullDiskAccess) return;
    if (!several) {
      endTurn();
      return showSource(updated);
    }
    takeTurn(updated);
    proceed("choose", turn);
  }).catch(orWarn(null));
}

export function continueImport(from: "choose" | "profiles", token: number | null) {
  const flow = importNow();
  if (flow.step.name !== from || flow.turn !== token) return;
  if (from === "choose" && flow.picked.length > 1) {
    const consent = consentToken();
    forgetCollectedLogins();
    if (!startRun()) return;
    runConsent = consent;
    return beginTurn();
  }
  if (from === "choose") return proceed("choose", startTurn(consentToken()));
  const turn = turnFor(token, "profiles");
  if (turn) proceed("profiles", turn);
}

function beginTurn() {
  const turn = startTurn(runConsent);
  const { run, browsers } = importNow();
  if (!run) return;
  const id = run.ids[run.at]!;
  const browser = browsers.find((b) => b.id === id);
  if (!browser) return void settleSource(turn, skippedOutcome({ id, name: id, family: "chromium" }));
  takeTurn(browser);
  proceed("choose", turn);
}

const skippedOutcome = (source: SourceOutcome["source"]): SourceOutcome => ({
  source,
  counts: emptyCounts(),
  failures: [],
  notes: [],
  extensions: { profileId: "", found: [], groups: [] },
  engines: [],
  skipped: true,
  consent: null,
  passwordsWritten: { keptExisting: 0, failed: 0 },
});

const SKIPPABLE: ImportStepName[] = ["access", "safari", "profiles"];

export function skipSource(token: number | null) {
  const flow = importNow();
  const turn = turnFor(token, ...SKIPPABLE);
  if (!flow.source || !turn || !inRun(flow)) return;
  void settleSource(turn, skippedOutcome(flow.source));
}

export async function settleSource(turn: ImportTurn, settled: SourceOutcome, logins: HeldLogins = []): Promise<boolean> {
  if (!claimSettle(turn)) return false;
  const { signal, consent } = turn;
  const outcome = { ...settled, consent };
  const { run } = importNow();
  if (!run || run.ids.length < 2) {
    await finishSource(outcome, consent, signal);
    return true;
  }
  collectLogins(outcome.source.id, consent, logins);
  const outcomes = [...run.outcomes, outcome];
  if (run.at + 1 < run.ids.length) {
    if (importNow().step.name === "progress") await pauseForDoneDelay();
    if (signal.aborted) return true;
    patchImport({ run: { ...run, at: run.at + 1, outcomes } });
    beginTurn();
    return true;
  }
  patchImport({ run: { ...run, outcomes } });
  await finishRun(outcomes, signal);
  return true;
}

function proceed(from: ImportStepName, turn: ImportTurn) {
  const { source, kinds, sourceProfiles } = importNow();
  if (!source) return;
  if (from === "choose") {
    if (source.needsFullDiskAccess) return patchImport({ step: { name: "access" } });
    if (source.requiresExport) return patchImport({ step: { name: "safari", error: null } });
    if (source.profiles.length > 1 || (importsBySpaces(source) && spacesOf(source).length > 1)) return patchImport({ step: { name: "profiles" } });
  }
  const sidebarKinds = DIA_SIDEBAR_KINDS.some((k) => kinds.has(k));
  const encryptedTabs = source.profiles.some((p) => sourceProfiles.includes(p.id) && p.tabsNeedKey && (kinds.has("tabs") || (!!p.diaSidebar && sidebarKinds)));
  const locked = (encryptedTabs || ENCRYPTED_KINDS.some((k) => kinds.has(k))) && source.needsKeychain && !importModule().isBrowserUnlocked(source.id);
  if ((from === "choose" || from === "profiles") && locked) return patchImport({ step: { name: "unlock", unlocking: false, error: null } });
  void importIn(turn, kinds, false);
}

let unlockAttempts = 0;

const stillUnlocking = (turn: ImportTurn, attempt: number) => {
  const { step } = importNow();
  return attempt === unlockAttempts && ownsTurn(turn) && step.name === "unlock" && step.unlocking;
};

export async function unlockAndImport(token: number | null) {
  const { source, step } = importNow();
  const turn = turnFor(token, "unlock");
  if (!source || !turn || step.name !== "unlock" || step.unlocking) return;
  const attempt = ++unlockAttempts;
  patchImport({ step: { name: "unlock", unlocking: true, error: step.error } });
  try {
    await whileOwned(turn, importModule().unlockBrowser(source.id), () => {
      if (stillUnlocking(turn, attempt)) void importIn(turn, importNow().kinds, false);
    });
  } catch {
    if (stillUnlocking(turn, attempt))
      patchImport({ step: { name: "unlock", unlocking: false, error: `macOS didn't allow access to ${source.name}'s keychain item. Try again, or skip the encrypted data.` } });
  }
}

export function skipEncryptedData(token: number | null) {
  const { kinds: chosen } = importNow();
  const turn = turnFor(token, "unlock");
  if (!turn) return;
  const kinds = new Set(chosen);
  kinds.delete("passwords");
  kinds.delete("cookies");
  patchImport({ kinds });
  void importIn(turn, kinds, true);
}

export function importUnlocked(token: number | null, wanted: ReadonlySet<ImportKind>, withoutKey: boolean) {
  const turn = turnFor(token, "unlock");
  return turn ? importIn(turn, wanted, withoutKey) : Promise.resolve();
}

export function runImport(wanted: ReadonlySet<ImportKind>, withoutKey = false) {
  if (liveTurn()) return Promise.resolve();
  return importIn(startTurn(consentToken()), wanted, withoutKey);
}

const importIn = (turn: ImportTurn, wanted: ReadonlySet<ImportKind>, withoutKey: boolean) => during("import", () => importAndSettle(turn, wanted, withoutKey));

async function importAndSettle(turn: ImportTurn, wanted: ReadonlySet<ImportKind>, withoutKey: boolean) {
  const { source } = importNow();
  if (!source || !claimRead(turn)) return;
  const job = { source, wanted, withoutKey, consent: turn.consent, signal: turn.signal, collecting: inRun(importNow()) };
  const read = job.collecting
    ? await runImportJob(job).catch(() => ({ outcome: brokenOutcome(source, wanted), logins: [] }))
    : await runImportJob(job);
  if (read) return void (await settleSource(turn, read.outcome, read.logins));
  releaseRead(turn);
}

function brokenOutcome(source: BrowserSource, wanted: ReadonlySet<ImportKind>): SourceOutcome {
  return { ...skippedOutcome(source), skipped: false, failures: IMPORT_KINDS.filter((k) => wanted.has(k)).map((kind) => ({ kind, profiles: [] })) };
}
