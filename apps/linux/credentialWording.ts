import type { Plugin } from "vite";

export type Wording = { file: string; replacements: [string, string][] };

export const CREDENTIAL_WORDING: readonly Wording[] = [
  {
    file: "components/settings/panes/ProfilePasswords.tsx",
    replacements: [
      [
        `  return systemInfo().inApplicationsFolder === false
    ? "For 1Password, move Ardia to Applications, then add it in its Settings › Browser."
    : "Their extensions work here. For 1Password, add Ardia in its Settings › Browser.";`,
        `  return "Password manager extensions such as 1Password, Bitwarden, KeePassXC and Proton Pass install from the Chrome Web Store. Ardia doesn't set up their connection to a desktop app on Linux yet.";`,
      ],
    ],
  },
  {
    file: "components/settings/panes/ProfileAutofill.tsx",
    replacements: [["Card numbers are kept in ${PLATFORM_TERMS.secretStore}.", "Card numbers are encrypted by Chromium with a key from your system keyring when one answers."]],
  },
  {
    file: "components/settings/rows/profileRows.ts",
    replacements: [
      [`keywords: ["password manager", "logins", "credentials", "keychain", "offer to save and fill passwords"]`, `keywords: ["password manager", "logins", "credentials", "keyring", "offer to save and fill passwords"]`],
      ["description: `Showing or filling a card asks for ${PLATFORM_TERMS.deviceUnlock}.`", `description: "Showing a saved card number asks for your system password."`],
    ],
  },
];

const marker = "/apps/browser/src/";

export function rewordWith(list: readonly Wording[], source: string, id: string, code: string): string | null {
  const at = id.indexOf(marker);
  if (at < 0) return null;
  const path = id.slice(at + marker.length).split("?")[0];
  const wording = list.find((entry) => entry.file === path);
  if (!wording) return null;
  let reworded = code;
  for (const [from, to] of wording.replacements) {
    if (!reworded.includes(from)) throw new Error(`${path} no longer contains ${JSON.stringify(from.slice(0, 80))}; update apps/linux/${source}`);
    reworded = reworded.replace(from, () => to);
  }
  return reworded;
}

export function rewordCredentials(id: string, code: string): string | null {
  return rewordWith(CREDENTIAL_WORDING, "credentialWording.ts", id, code);
}

export function wordingPlugin(name: string, list: readonly Wording[], source: string): Plugin {
  const applied = new Set<string>();
  let building = false;
  return {
    name,
    enforce: "pre",
    configResolved(config) {
      building = config.command === "build";
    },
    transform(code, id) {
      const reworded = rewordWith(list, source, id, code);
      if (reworded === null) return null;
      applied.add(id.slice(id.indexOf(marker) + marker.length).split("?")[0] ?? "");
      return { code: reworded, map: null };
    },
    buildEnd(error) {
      if (!building || error) return;
      const settingsPanes = [...this.getModuleIds()].some((id) => id.includes(`${marker}components/settings/panes/`));
      if (!settingsPanes) return;
      const missing = list.map((entry) => entry.file).filter((file) => !applied.has(file));
      if (missing.length) this.error(`${source} never reworded ${missing.join(", ")}; update apps/linux/${source}`);
    },
  };
}

export function credentialWording(): Plugin {
  return wordingPlugin("ardia-linux:credential-wording", CREDENTIAL_WORDING, "credentialWording.ts");
}
