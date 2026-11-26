import { configureExtension } from "../../platform/extensions";
import { refreshExtensionsAfterChange } from "./lists";
import { consentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";
import { noteExtensionSiteChange } from "../telemetry/usage";
import { extensionSitePattern } from "./sitePatterns";

export { extensionSiteLabel, extensionSitePattern } from "./sitePatterns";

const INVALID_SITE = "Enter a site like example.com or https://*.example.com. A port needs http:// or https:// in front.";

const reason = (error: unknown, fallback: string) => {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.trim() ? `${message.trim().replace(/\.$/, "")}.` : fallback;
};

async function changeSite(profile: string, id: string, options: Parameters<typeof configureExtension>[2], fallback: string): Promise<string | null> {
  const consent = consentToken();
  let problem: string | null = null;
  try {
    await configureExtension(id, profile, options);
  } catch (error) {
    if (consent) warnFor(consent, "[extensions] site change failed", error);
    problem = reason(error, fallback);
  }
  noteExtensionSiteChange(problem ? "failed" : options.grantSite ? "added" : "removed", consent);
  await refreshExtensionsAfterChange(profile, consent);
  return problem;
}

export function addExtensionSite(profile: string, id: string, typed: string): Promise<string | null> {
  const site = extensionSitePattern(typed);
  if (!site) return Promise.resolve(INVALID_SITE);
  return changeSite(profile, id, { siteAccess: "specificSites", grantSite: site }, "Ardia couldn't give the extension access to that site.");
}

export const removeExtensionSite = (profile: string, id: string, site: string) =>
  changeSite(profile, id, { revokeSite: site }, "Ardia couldn't take that site away from the extension.");

export const noteExtensionSitePickerCancelled = () => noteExtensionSiteChange("cancelled");
