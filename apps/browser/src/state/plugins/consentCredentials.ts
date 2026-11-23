import { hasSecretField, verbWords, type CredentialProviderSpec } from "../../lib/pluginCredentialProvider";
import { consentLine, listed, type ConsentLine } from "./consentLine";

function readsLine(spec: CredentialProviderSpec): ConsentLine {
  const caps = spec.capabilities;
  const saves = caps.includes("save") || caps.includes("edit");
  const what = caps.includes("passkeys") ? "Reads and saves logins and passkeys" : saves ? "Reads and saves logins" : "Reads logins";
  return consentLine("reaches", "key.fill", `${what} in ${spec.title}`);
}

export function credentialProviderLines(spec: CredentialProviderSpec | null): ConsentLine[] {
  if (!spec) return [];
  const caps = spec.capabilities;
  const program = spec.cli.name;
  const lines: ConsentLine[] = [
    readsLine(spec),
    consentLine("reaches", "terminal.fill", `Runs ${program} on your Mac, only for these commands`, { items: verbWords(spec), code: true, detail: "Outside Ardia's sandbox" }),
  ];
  if (hasSecretField(spec)) lines.push(consentLine("limits", "lock.shield", `Your secrets go only to ${program}`, { detail: "What you type in its secret fields never reaches the plugin" }));
  if (caps.includes("passkeys")) lines.push(consentLine("reaches", "globe", "Gets a site's address", { detail: "When you save a login or passkey for it" }));
  else if (caps.includes("save")) lines.push(consentLine("reaches", "globe", "Gets a site's address", { detail: "When you save a login for it" }));
  for (const app of new Set(spec.signIn.methods.flatMap((m) => (m.kind === "desktopApproval" && m.appTitle ? [m.appTitle] : [])))) lines.push(consentLine("reaches", "checkmark.shield", `Asks ${app} to approve Ardia when you sign in`));
  if (spec.signIn.approvalHosts.length) lines.push(consentLine("reaches", "safari", `Opens ${listed(spec.signIn.approvalHosts)} in a new tab when you sign in`));
  if (caps.includes("touchID") && caps.includes("masterPassword")) lines.push(consentLine("reaches", "touchid", `Can keep ${spec.title} unlocked with Touch ID`, { detail: "Its session stays in your Keychain" }));
  return lines;
}
