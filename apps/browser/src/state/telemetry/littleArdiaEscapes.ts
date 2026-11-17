export type EscapePressedIn = "page" | "window" | "blankBar";

const none = (): Record<EscapePressedIn, number> => ({ page: 0, window: 0, blankBar: 0 });

let closes = none();
const noHandoffs = () => ({ appLinkCloses: 0, returnsToApp: 0, globalShortcutOpens: 0, fitsBelowSaved: 0 });

let handoffs = noHandoffs();

const handoffCounter = { appLinkClose: "appLinkCloses", returnToApp: "returnsToApp", globalShortcut: "globalShortcutOpens" } as const;

export function noteLittleArdiaAppHandoff(what: keyof typeof handoffCounter) {
  handoffs[handoffCounter[what]]++;
}

export function noteLittleArdiaFitBelowSaved() {
  handoffs.fitsBelowSaved++;
}

export function noteLittleArdiaEscapeClose(pressedIn: EscapePressedIn) {
  closes[pressedIn]++;
}

export function takeLittleArdiaEscapeCloses() {
  const taken = closes;
  const handedOff = handoffs;
  closes = none();
  handoffs = noHandoffs();
  return {
    little_ardia_app_link_closes: handedOff.appLinkCloses,
    little_ardia_returns_to_app: handedOff.returnsToApp,
    little_ardia_global_shortcut_opens: handedOff.globalShortcutOpens,
    little_ardia_fits_below_saved_size: handedOff.fitsBelowSaved,
    little_ardia_escape_closes: taken.page,
    little_ardia_escape_closes_unfocused: taken.window,
    little_ardia_escape_closes_blank: taken.blankBar,
  };
}
