import type { PasswordAppPairing } from "./passwordAppPairing";

export type { PasswordAppPairing };

export function passwordAppPairing(): PasswordAppPairing | null {
  return {
    title: "Connect to the 1Password app",
    steps:
      "The 1Password app unlocks its extension only in browsers it knows. Until it knows Ardia, the extension locks itself on its own timer. As root, add a line with Ardia's program name, chrome, to /etc/1password/custom_allowed_browsers, then quit and reopen 1Password.",
    appPath: null,
  };
}
