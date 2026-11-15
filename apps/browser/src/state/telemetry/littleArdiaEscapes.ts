export type EscapePressedIn = "page" | "window" | "blankBar";

const none = (): Record<EscapePressedIn, number> => ({ page: 0, window: 0, blankBar: 0 });

let closes = none();
let handoffs = { appLinkCloses: 0, returnsToApp: 0 };

export function noteLittleArdiaAppHandoff(what: "appLinkClose" | "returnToApp") {
  handoffs[what === "appLinkClose" ? "appLinkCloses" : "returnsToApp"]++;
}

export function noteLittleArdiaEscapeClose(pressedIn: EscapePressedIn) {
  closes[pressedIn]++;
}

export function takeLittleArdiaEscapeCloses() {
  const taken = closes;
  const handedOff = handoffs;
  closes = none();
  handoffs = { appLinkCloses: 0, returnsToApp: 0 };
  return {
    little_ardia_app_link_closes: handedOff.appLinkCloses,
    little_ardia_returns_to_app: handedOff.returnsToApp,
    little_ardia_escape_closes: taken.page,
    little_ardia_escape_closes_unfocused: taken.window,
    little_ardia_escape_closes_blank: taken.blankBar,
  };
}
