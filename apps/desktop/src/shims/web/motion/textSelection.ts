const RESPONDER_CLAIMS = ["onStartShouldSetResponder", "onStartShouldSetResponderCapture", "onMoveShouldSetResponder", "onMoveShouldSetResponderCapture"] as const;

type ResponderClaims = Partial<Record<(typeof RESPONDER_CLAIMS)[number], unknown>>;

export const UNSELECTABLE = { userSelect: "none" } as const;

export function claimsResponder(props: ResponderClaims): boolean {
  return RESPONDER_CLAIMS.some((name) => !!props[name]);
}

export function withoutTextSelection(props: ResponderClaims, style: unknown): unknown {
  return claimsResponder(props) ? [UNSELECTABLE, style] : style;
}
