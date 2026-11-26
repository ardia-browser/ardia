import { hideChromeLists } from "../../platform/passwords";
import { warnFor } from "../telemetry/consoleConsent";
import type { ConsentToken } from "../telemetry/choice";
import type { PasswordManagerChoice } from "./passwordManagerChoice";

export const chromeListProfiles = (modes: ReadonlyMap<string, PasswordManagerChoice>): string[] =>
  [...modes].filter(([, mode]) => mode === "apple").map(([profile]) => profile).sort();

let pushed: string | null = null;

export function pushChromeLists(profiles: readonly string[], consent: ConsentToken | null) {
  const key = JSON.stringify(profiles);
  if (key === pushed) return;
  pushed = key;
  hideChromeLists([...profiles]).catch((e: unknown) => {
    if (pushed === key) pushed = null;
    warnFor(consent, `[passwords] native refused hideChromeLists: ${e instanceof Error ? e.message : String(e)}`);
  });
}
