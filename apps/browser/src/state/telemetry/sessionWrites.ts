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

export function noteSessionWrite(length: number, cosmeticOnly: boolean) {
  writes++;
  if (cosmeticOnly) cosmeticWrites++;
  characters += length;
}

export function takeSessionWrites() {
  const taken = { session_writes: writes, session_cosmetic_writes: cosmeticWrites, session_kb_written: Math.round(characters / 1024), session_pin_backups: pinBackups, session_pins_backed_up: pinsBackedUp, session_pin_backup_failures: pinBackupFailures, session_pin_backups_beside: pinBackupsBeside, session_pin_choice_repairs: pinChoiceRepairs, session_saves: saves, session_save_ms_total: Math.round(saveMsTotal), session_save_ms_max: Math.round(saveMsMax) };
  writes = 0;
  cosmeticWrites = 0;
  characters = 0;
  pinBackups = 0;
  pinsBackedUp = 0;
  pinBackupFailures = 0;
  pinBackupsBeside = 0;
  pinChoiceRepairs = 0;
  saves = 0;
  saveMsTotal = 0;
  saveMsMax = 0;
  return taken;
}
