import { documentSaved, readDocument, writeDocument } from "../../platform/documents";
import { create } from "zustand";
import { readContext, type SavedContext } from "./savedContext";
import { uuidv4, uuidv7 } from "./ids";
import { telemetryRelay } from "./relay";
import { consentToken, counted, setConsentPeriod, stillValid, type ConsentToken } from "./consentPeriod";
import { parseSaved, versionedJson, unchanged, type Migrations, type SavedObject } from "../../lib/savedDocument";
import { isFields, isString, numberOr, stringOr } from "../../lib/decode";

const STATE_DOC = "telemetry.json";
const STATE_VERSION = 2;
const STATE_MIGRATIONS: Migrations = { 0: unchanged, 1: (doc) => ({ ...doc, versionSince: null, versionColdLaunches: null }) };

export type Watch = {
  watchReport: string | null;
  watchStartedAt: number | null;
  watchUntil: number | null;
  sharingUntil: number | null;
  watchCountedMs: number;
  watchCheckedAt: number | null;
  watchEndedNotice: string | null;
};

export type Session = {
  decidedAt: number | null;
  askDoneAt: number | null;
  crashCursor: number;
  lastVersion: string | null;
  sessionOpen: boolean;
  sessionId: string | null;
  channel: string | null;
  lastLaunchAt: number | null;
  lastQuitAt: number | null;
  lastBuild: string | null;
  versionSince: number | null;
  versionColdLaunches: number | null;
  settingsDay: string | null;
  context: SavedContext | null;
  epoch: string | null;
} & Watch;
type Sharing = { sharing: false; installId: string | null } | { sharing: true; installId: string };
export type Saved = Session & Sharing;

export const NO_WATCH: Watch = {
  watchReport: null,
  watchStartedAt: null,
  watchUntil: null,
  sharingUntil: null,
  watchCountedMs: 0,
  watchCheckedAt: null,
  watchEndedNotice: null,
};

const DEFAULT: Saved = {
  sharing: false,
  installId: null,
  decidedAt: null,
  askDoneAt: null,
  crashCursor: 0,
  lastVersion: null,
  sessionOpen: false,
  sessionId: null,
  channel: null,
  lastLaunchAt: null,
  lastQuitAt: null,
  lastBuild: null,
  versionSince: null,
  versionColdLaunches: null,
  settingsDay: null,
  context: null,
  epoch: null,
  ...NO_WATCH,
};

function readWatch(doc: SavedObject): Watch {
  const report = stringOr(doc.watchReport, null);
  const startedAt = numberOr(doc.watchStartedAt, null);
  const until = numberOr(doc.watchUntil, null);
  const notice = stringOr(doc.watchEndedNotice, null);
  if (!report || startedAt === null || until === null || until <= startedAt) return { ...NO_WATCH, watchEndedNotice: notice };
  return {
    watchReport: report,
    watchStartedAt: startedAt,
    watchUntil: until,
    sharingUntil: numberOr(doc.sharingUntil, null),
    watchCountedMs: Math.max(0, numberOr(doc.watchCountedMs, 0) ?? 0),
    watchCheckedAt: numberOr(doc.watchCheckedAt, null),
    watchEndedNotice: notice,
  };
}

const legacyEpoch = (doc: SavedObject) => `legacy:${stringOr(doc.installId, "") ?? ""}:${numberOr(doc.decidedAt, 0) ?? 0}`;

function readSaved(doc: SavedObject | null): Saved {
  if (!doc) return DEFAULT;
  const installId = isString(doc.installId) && doc.installId ? doc.installId : null;
  const sharing: Sharing = doc.sharing === true && installId ? { sharing: true, installId } : { sharing: false, installId };
  return {
    ...sharing,
    decidedAt: numberOr(doc.decidedAt, null),
    askDoneAt: numberOr(doc.askDoneAt, null),
    crashCursor: numberOr(doc.crashCursor, 0),
    lastVersion: stringOr(doc.lastVersion, null),
    sessionOpen: doc.sessionOpen === true,
    sessionId: stringOr(doc.sessionId, null),
    channel: stringOr(doc.channel, null),
    lastLaunchAt: numberOr(doc.lastLaunchAt, null),
    lastQuitAt: numberOr(doc.lastQuitAt, null),
    lastBuild: stringOr(doc.lastBuild, null),
    versionSince: numberOr(doc.versionSince, null),
    versionColdLaunches: numberOr(doc.versionColdLaunches, null),
    epoch: stringOr(doc.epoch, null) ?? (sharing.sharing ? legacyEpoch(doc) : null),
    settingsDay: stringOr(doc.settingsDay, null),
    context: readContext(doc.context),
    ...readWatch(doc),
  };
}

let saved: Saved = DEFAULT;

export const savedChoice = (): Readonly<Saved> => saved;

type Shown = { sharing: boolean; epoch: string | null; decided: boolean; askDone: boolean; installId: string | null; watchReport: string | null; watchUntil: number | null; sharingUntil: number | null };

export const useTelemetry = create<Shown>()(() => ({
  sharing: false,
  epoch: null,
  decided: false,
  askDone: false,
  installId: null,
  watchReport: null,
  watchUntil: null,
  sharingUntil: null,
}));

const shown = (s: Saved): Shown => ({
  sharing: s.sharing,
  epoch: s.sharing ? s.epoch : null,
  decided: s.decidedAt !== null,
  askDone: s.askDoneAt !== null,
  installId: s.installId,
  watchReport: s.watchReport,
  watchUntil: s.watchUntil,
  sharingUntil: s.sharingUntil,
});

export { consentToken, consentToken as consentNow, counted, stillValid, type ConsentToken };
export const consentEpoch = () => (saved.sharing && saved.epoch ? saved.epoch : "");

export const onConsentPeriodChange = (fn: () => void) =>
  useTelemetry.subscribe((current, previous) => {
    if (current.sharing !== previous.sharing || current.epoch !== previous.epoch) fn();
  });

export function save(patch: Partial<Session> | (Partial<Session> & Sharing)) {
  const was = saved;
  saved = { ...saved, ...patch } as Saved;
  if (saved.sharing !== was.sharing || saved.installId !== was.installId || !saved.epoch) saved = { ...saved, epoch: uuidv4() };
  setConsentPeriod(saved.sharing, saved.epoch);
  try {
    writeDocument(STATE_DOC, versionedJson(saved, STATE_VERSION));
  } catch {}
  useTelemetry.setState(shown(saved));
}

export const isSharing = () => saved.sharing;

const offOnDisk = () => readStateDoc()?.sharing !== true;

export async function savedOff(): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) writeDocument(STATE_DOC, versionedJson(saved, STATE_VERSION));
      await documentSaved(STATE_DOC);
      if (offOnDisk()) return true;
    } catch {}
  }
  return false;
}

let currentSession: string | null = null;
export const sessionId = () => (currentSession ??= uuidv7());
export const startNewSession = () => (currentSession = uuidv7());
export const resumeSession = (id: string | null) => (currentSession = id ?? uuidv7());

function readStateDoc(): SavedObject | null {
  const json = readDocument(STATE_DOC);
  const current = parseSaved(json, STATE_VERSION, STATE_MIGRATIONS);
  if (current || !json) return current;
  try {
    const fromOtherVersion: unknown = JSON.parse(json);
    return isFields(fromOtherVersion) ? fromOtherVersion : null;
  } catch {
    return null;
  }
}

let loaded = false;
let launchConsent: ConsentToken | null | undefined;

export function loadChoice() {
  if (loaded) return;
  loaded = true;
  saved = readSaved(readStateDoc());
  setConsentPeriod(saved.sharing, saved.epoch);
  if (launchConsent === undefined) launchConsent = consentToken();
  useTelemetry.setState(shown(saved));
}

export const choiceLoaded = () => loaded;

export const consentAtLaunch = () => launchConsent ?? null;

export function reloadChoice() {
  loaded = false;
  loadChoice();
}

export function dismissAsk() {
  const relay = telemetryRelay();
  if (relay) return relay.change({ kind: "askDismissed" });
  save({ askDoneAt: Date.now() });
}
