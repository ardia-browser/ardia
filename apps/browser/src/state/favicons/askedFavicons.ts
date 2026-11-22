const asked = new Set<string>();
const failedFetches = new Set<string>();

const askId = (key: string, page: string) => `${key}|${page}`;

export function markAsked(key: string, page: string): boolean {
  const id = askId(key, page);
  if (asked.has(id)) return false;
  asked.add(id);
  return true;
}

export const unmarkAsked = (key: string, page: string) => void asked.delete(askId(key, page));

export function forgetAsked(key: string, kept: Record<string, unknown> = {}) {
  const prefix = askId(key, "");
  for (const id of [...asked]) if (id.startsWith(prefix) && !(id.slice(prefix.length) in kept)) asked.delete(id);
}

export const fetchFailedBefore = (id: string) => failedFetches.has(id);

export function noteFetchFailed(id: string, kept: number) {
  if (failedFetches.size >= kept) failedFetches.delete(failedFetches.values().next().value!);
  failedFetches.add(id);
}
