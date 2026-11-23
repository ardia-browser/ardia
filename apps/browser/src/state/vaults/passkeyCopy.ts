import type { PasskeyRoute } from "./passkeyTarget";

export type PasskeyTrouble = "returned" | "systemFailed";

export function troubleText(trouble: PasskeyTrouble, creating: boolean, name: string, site: string): string {
  if (trouble === "returned") {
    return creating ? `${name} didn't save the passkey. It may be locked. Try again, or save it somewhere else.` : `${name} didn't sign you in. It may be locked, or have no passkey for ${site}. Try again, or choose another way.`;
  }
  return creating ? `macOS couldn't save the passkey to ${name}. Try again, or save it somewhere else.` : `macOS didn't get a passkey for ${site} from ${name}. Try again, or choose another way.`;
}

export function saveLine(route: PasskeyRoute, name: string, check: string, privateWindow: boolean): string {
  const stays = privateWindow ? " It stays after this window closes." : "";
  if (route === "system") return `macOS will ask where to save it. Choose ${name} there.${stays}`;
  if (route === "extension") return `${name} will ask which login or vault to save it in.${stays}`;
  if (privateWindow) return `Saves to ${name}, and stays there after this window closes. You'll sign in with ${check}.`;
  return check === "Touch ID" ? `Saves to ${name}. You'll sign in with Touch ID, no password needed.` : `Saves to ${name}. You'll sign in with your login password.`;
}

export function signInLine(route: PasskeyRoute, name: string, check: string, many: boolean): string {
  const choose = many ? "Choose a passkey. " : "";
  if (route === "system") return `${choose}macOS will ask ${name} for your passkey.`;
  if (route === "extension") return `${choose}${name} will ask you to confirm.`;
  return `${choose}You'll confirm with ${check}.`;
}
