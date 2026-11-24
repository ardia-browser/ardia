import { consentOrNow, countFor, type ConsentToken } from "./consentPeriod";
import { beginActivity } from "../app/jobActivity";

let writes = 0;
let cosmeticWrites = 0;
let characters = 0;
let pinBackups = 0;
let pinsBackedUp = 0;
let pinBackupFailures = 0;
let pinBackupsBeside = 0;
let pinChoiceRepairs = 0;
const SET_ASIDE_REASONS = ["empty", "invalid", "shape", "newer", "unreadable", "rows"] as const;
type SetAsideReason = (typeof SET_ASIDE_REASONS)[number];
const noneSetAside = () => Object.fromEntries(SET_ASIDE_REASONS.map((r) => [r, 0])) as Record<SetAsideReason, number>;
let setAside = noneSetAside();
let downloadsSetAside = 0;
let setAsideFailures = 0;
let restoredFromBackup = 0;
let restoredBackupDaysMax = 0;
let backups = 0;
let backupsBeforeMigration = 0;
let saves = 0;
let saveMsTotal = 0;
let saveMsMax = 0;

export function timeSessionSave(): (() => void) & { sessionStarts: () => void } {
  const end = beginActivity("sessionSave");
  const consent = consentOrNow(undefined);
  let began: number | null = null;
  const done = () => {
    end();
    if (began === null) return;
    const ms = performance.now() - began;
    countFor(consent, () => {
      saves++;
      saveMsTotal += ms;
      saveMsMax = Math.max(saveMsMax, ms);
    });
  };
  return Object.assign(done, { sessionStarts: () => void (began = performance.now()) });
}

export function noteSessionPinBackup(pins: number, consent?: ConsentToken | null, beside = false) {
  countFor(consentOrNow(consent), () => {
    pinBackups++;
    pinsBackedUp += pins;
    if (beside) pinBackupsBeside++;
  });
}

export function noteSessionPinBackupFailure(consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void pinBackupFailures++);
}

export const notePinChoicesRepaired = () => countFor(consentOrNow(undefined), () => void pinChoiceRepairs++);

export function noteSessionSetAside(session: boolean, reason: SetAsideReason, restoredBackupDays: number | null, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => {
    if (!session) return void downloadsSetAside++;
    setAside[reason]++;
    if (restoredBackupDays === null) return;
    restoredFromBackup++;
    restoredBackupDaysMax = Math.max(restoredBackupDaysMax, restoredBackupDays);
  });
}

export const noteSessionSetAsideFailure = (session: boolean, consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void (session && setAsideFailures++));

export function noteSessionBackup(beforeMigration: boolean, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => {
    backups++;
    if (beforeMigration) backupsBeforeMigration++;
  });
}

export function noteSessionWrite(length: number, cosmeticOnly: boolean) {
  writes++;
  if (cosmeticOnly) cosmeticWrites++;
  characters += length;
}

export function takeSessionWrites() {
  const taken = { session_writes: writes, session_cosmetic_writes: cosmeticWrites, session_kb_written: Math.round(characters / 1024), session_pin_backups: pinBackups, session_pins_backed_up: pinsBackedUp, session_pin_backup_failures: pinBackupFailures, session_pin_backups_beside: pinBackupsBeside, session_pin_choice_repairs: pinChoiceRepairs, ...Object.fromEntries(SET_ASIDE_REASONS.map((r) => [`session_set_aside_${r}`, setAside[r]])), session_set_aside_failures: setAsideFailures, session_restored_from_backup: restoredFromBackup, session_restored_backup_days_max: restoredBackupDaysMax, downloads_set_aside: downloadsSetAside, session_backups: backups, session_backups_before_migration: backupsBeforeMigration, session_saves: saves, session_save_ms_total: Math.round(saveMsTotal), session_save_ms_max: Math.round(saveMsMax) };
  writes = 0;
  cosmeticWrites = 0;
  characters = 0;
  pinBackups = 0;
  pinsBackedUp = 0;
  pinBackupFailures = 0;
  pinBackupsBeside = 0;
  pinChoiceRepairs = 0;
  setAside = noneSetAside();
  downloadsSetAside = 0;
  setAsideFailures = 0;
  restoredFromBackup = 0;
  restoredBackupDaysMax = 0;
  backups = 0;
  backupsBeforeMigration = 0;
  saves = 0;
  saveMsTotal = 0;
  saveMsMax = 0;
  return taken;
}
