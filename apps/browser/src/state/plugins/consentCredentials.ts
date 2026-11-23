import { hasSecretField, verbWords, type CredentialProviderSpec } from "../../lib/pluginCredentialProvider";

type Line = { icon: string; text: string };

const listed = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

function readsLine(spec: CredentialProviderSpec): Line {
  const caps = spec.capabilities;
  const saves = caps.includes("save") || caps.includes("edit");
  const text = caps.includes("passkeys") ? `Reads and saves logins and passkeys in ${spec.title}` : saves ? `Reads and saves logins in ${spec.title}` : `Reads logins in ${spec.title}`;
  return { icon: "key.fill", text };
}

export function credentialProviderLines(spec: CredentialProviderSpec | null): Line[] {
  if (!spec) return [];
  const caps = spec.capabilities;
  const program = spec.cli.name;
  const lines: Line[] = [readsLine(spec), { icon: "terminal.fill", text: `Runs ${program} on your Mac, outside Ardia's sandbox, only for: ${listed(verbWords(spec))}` }];
  if (hasSecretField(spec)) lines.push({ icon: "lock.shield", text: `What you type in its secret fields goes to ${program}, never to the plugin` });
  if (caps.includes("passkeys")) lines.push({ icon: "globe", text: "Gets a site's address when you save a login or passkey for it" });
  else if (caps.includes("save")) lines.push({ icon: "globe", text: "Gets a site's address when you save a login for it" });
  for (const app of new Set(spec.signIn.methods.flatMap((m) => (m.kind === "desktopApproval" && m.appTitle ? [m.appTitle] : [])))) lines.push({ icon: "checkmark.shield", text: `Asks ${app} to approve Ardia when you sign in` });
  if (spec.signIn.approvalHosts.length) lines.push({ icon: "safari", text: `Opens ${listed(spec.signIn.approvalHosts)} in a new tab when you sign in` });
  if (caps.includes("touchID") && caps.includes("masterPassword")) lines.push({ icon: "touchid", text: `Can keep ${spec.title} unlocked with Touch ID, holding its session in your Keychain` });
  return lines;
}
