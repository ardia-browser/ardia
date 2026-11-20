import { exportPasswords as exportPasswordsOf } from "../../platform/passwords";
import { notePasswordExport, notePasswordExportFailure } from "../telemetry/exportCounts";
import { consentToken } from "../telemetry/client";

export {
  deletePassword,
  getNeverSavePasswordOrigins,
  getPassword,
  listPasswords,
  savePassword,
  setNeverSavePasswords,
  setPasswordAutofill,
  unlockPasswords,
  updatePassword,
  type PasswordExportStatus,
  type SavedPassword,
} from "../../platform/passwords";

export async function exportPasswords(profile: string) {
  const consent = consentToken();
  const result = await exportPasswordsOf(profile).catch((error: unknown) => {
    notePasswordExportFailure(consent);
    throw error;
  });
  if (result.status === "succeeded") notePasswordExport(consent);
  if (result.status === "writeFailed") notePasswordExportFailure(consent);
  return result;
}
