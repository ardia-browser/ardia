import type { SavedPassword } from "../site/passwords";

type Login = Pick<SavedPassword, "origin" | "username">;

export function deleteLoginMessage(saved: Login, list: readonly Login[]): string {
  const name = saved.username.trim();
  const shared = list.filter((other) => other.origin === saved.origin).length > 1;
  return shared && name ? `Ardia won't fill ${name} on this website anymore.` : "Ardia won't fill it on this website anymore.";
}
