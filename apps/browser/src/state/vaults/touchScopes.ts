const join = (...parts: string[]) => parts.join("\n");

export const touchScope = {
  fill: (provider: string, item: string, origin: string, tab: string) => join("fill", provider, item, origin, tab),
  unlock: (provider: string) => join("unlock", provider),
  passkey: (request: string, credential: string) => join("passkey", request, credential),
  card: (card: string, tab: string) => join("autofill-card", card, tab),
};
