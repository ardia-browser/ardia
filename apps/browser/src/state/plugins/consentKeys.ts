import { t } from "../../lib/uiLanguage";
export type ConsentButton = "cancel" | "install";

export type ConsentKeyState = { selected: ConsentButton | null; spaceDown: boolean };

export type ConsentKeyPress = { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean };

export const CONSENT_KEYS = [{ key: t(`Escape`) }, { key: t(`Tab`) }, { key: t(`Tab`), shiftKey: true }, { key: " " }];

export const CONSENT_KEYS_UP = [{ key: " " }];

export const FRESH_CONSENT_KEYS: ConsentKeyState = { selected: null, spaceDown: false };

export function consentKeyDown(state: ConsentKeyState, e: ConsentKeyPress, canInstall: boolean): { state: ConsentKeyState; press: ConsentButton | null } {
  const none = { state, press: null };
  if (e.altKey || e.ctrlKey || e.metaKey) return none;
  if (e.key === "Escape") return e.shiftKey ? none : { state, press: "cancel" };
  if (e.key === " ") {
    if (e.shiftKey || state.spaceDown) return none;
    const press = state.selected === "install" && !canInstall ? null : state.selected;
    return { state: { ...state, spaceDown: true }, press };
  }
  if (e.key !== "Tab") return none;
  const order: ConsentButton[] = canInstall ? ["cancel", "install"] : ["cancel"];
  const at = state.selected === null ? -1 : order.indexOf(state.selected);
  const back = !!e.shiftKey;
  const next = at === -1 ? (back ? order.length - 1 : 0) : (at + (back ? order.length - 1 : 1)) % order.length;
  return { state: { ...state, selected: order[next] ?? null }, press: null };
}

export const consentKeyUp = (state: ConsentKeyState, e: ConsentKeyPress): ConsentKeyState => (e.key === " " ? { ...state, spaceDown: false } : state);
