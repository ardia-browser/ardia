export type ConsentButton = "cancel" | "install";

export const CONSENT_KEYS = [{ key: "Escape" }, { key: "Tab" }, { key: "Tab", shiftKey: true }, { key: " " }];

export function consentKey(selected: ConsentButton | null, key: string, shift: boolean, canInstall: boolean): { selected: ConsentButton | null; press: ConsentButton | null } {
  if (key === "Escape") return { selected, press: "cancel" };
  if (key === " ") return { selected, press: selected === "install" && !canInstall ? null : selected };
  if (key !== "Tab") return { selected, press: null };
  const order: ConsentButton[] = canInstall ? ["cancel", "install"] : ["cancel"];
  const at = selected === null ? -1 : order.indexOf(selected);
  const next = at === -1 ? (shift ? order.length - 1 : 0) : (at + (shift ? order.length - 1 : 1)) % order.length;
  return { selected: order[next] ?? null, press: null };
}
