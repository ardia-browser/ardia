import { fileExists, systemInfo } from "../app/system";

export type PasswordAppPairing = { title: string; steps: string; appPath: string | null };

const ONE_PASSWORD_APP = "/Applications/1Password.app";

export function passwordAppPairing(): PasswordAppPairing | null {
  if (!fileExists(ONE_PASSWORD_APP)) return null;
  const trust = "The 1Password app unlocks its extension only in browsers it trusts. Until it trusts Ardia, the extension locks itself on its own timer.";
  const steps =
    systemInfo().inApplicationsFolder === false
      ? `${trust} Move Ardia to your Applications folder and reopen it (1Password only connects to browsers there), then in the 1Password app open Settings › Browser › Add Browser and choose Ardia.`
      : `${trust} In the 1Password app, open Settings › Browser › Add Browser and choose Ardia.`;
  return { title: "Connect to the 1Password app", steps, appPath: ONE_PASSWORD_APP };
}
