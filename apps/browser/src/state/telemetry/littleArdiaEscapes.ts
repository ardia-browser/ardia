export type EscapePressedIn = "page" | "window" | "blankBar";

const none = (): Record<EscapePressedIn, number> => ({ page: 0, window: 0, blankBar: 0 });

let closes = none();
const noHandoffs = () => ({ appLinkCloses: 0, returnsToApp: 0, opensFromOtherApps: 0 });

let handoffs = noHandoffs();

const HANDOFF_COUNTS = { appLinkClose: "appLinkCloses", returnToApp: "returnsToApp", openFromOtherApp: "opensFromOtherApps" } as const;

export function noteLittleArdiaAppHandoff(what: keyof typeof HANDOFF_COUNTS) {
  handoffs[HANDOFF_COUNTS[what]]++;
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
    little_ardia_opens_from_other_apps: handedOff.opensFromOtherApps,
    little_ardia_escape_closes: taken.page,
    little_ardia_escape_closes_unfocused: taken.window,
    little_ardia_escape_closes_blank: taken.blankBar,
  };
}
