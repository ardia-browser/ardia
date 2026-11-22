import { consentOrNow, countFor, type ConsentToken } from "./consentPeriod";

let writes = 0;
let cosmeticWrites = 0;
let characters = 0;
let pinBackups = 0;
let pinsBackedUp = 0;
let pinBackupFailures = 0;

export function noteSessionPinBackup(pins: number, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => {
    pinBackups++;
    pinsBackedUp += pins;
  });
}

export function noteSessionPinBackupFailure(consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void pinBackupFailures++);
}

export function noteSessionWrite(length: number, cosmeticOnly: boolean) {
  writes++;
  if (cosmeticOnly) cosmeticWrites++;
  characters += length;
}

export function takeSessionWrites() {
  const taken = { session_writes: writes, session_cosmetic_writes: cosmeticWrites, session_kb_written: Math.round(characters / 1024), session_pin_backups: pinBackups, session_pins_backed_up: pinsBackedUp, session_pin_backup_failures: pinBackupFailures };
  writes = 0;
  cosmeticWrites = 0;
  characters = 0;
  pinBackups = 0;
  pinsBackedUp = 0;
  pinBackupFailures = 0;
  return taken;
}
