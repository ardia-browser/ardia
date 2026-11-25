import { capture, queueSavedDurably, stillValid, type ConsentToken } from "./client";
import { telemetryRelay } from "./relay";
import { HOST_SHELL, type HostShell } from "./hostShell";
import { reportShellMigration } from "./shellMigration";
import { documentSaved, readDocument, saveDocument } from "../../platform/documents";

let launchReport: Promise<string> | null = null;
let launchConsent: { consent: ConsentToken | null } | null = null;

export const noteLaunchConsent = (consent: ConsentToken | null) => void (launchConsent = { consent });

export function reportShellMigrationAfterLead() {
  const noted = launchConsent;
  launchConsent = null;
  return noted ? reportShellMigrationAtLaunch(noted.consent) : Promise.resolve("none");
}

export async function reportShellMigrationAtLaunch(consent: ConsentToken | null, shell: HostShell | null = HOST_SHELL) {
  if (shell !== "webui") return "none";
  if (telemetryRelay()) return "held";
  launchReport ??= reportShellMigration({
    read: readDocument,
    save: async (name, contents) => {
      await saveDocument(name, contents);
      await documentSaved(name);
    },
    sharing: () => stillValid(consent),
    send: (properties) => capture("shell_migration", properties, consent, { persist: true }),
    persisted: () => queueSavedDurably(),
  }).catch(() => "unsaved");
  return launchReport;
}
