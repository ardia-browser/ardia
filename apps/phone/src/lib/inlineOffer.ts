export type InlineOffer = { query: string; completion: string };

export function inlineOffer(completion: string, suggestedFor: string): InlineOffer | null {
  if (!suggestedFor) return null;
  return { query: suggestedFor, completion: completion ? suggestedFor + completion : "" };
}
