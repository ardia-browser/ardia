const consumers = new Map<string, (url: string) => boolean>();

export function consumeCallbackUrls(tabId: string, consume: (url: string) => boolean): () => void {
  consumers.set(tabId, consume);
  return () => {
    if (consumers.get(tabId) === consume) consumers.delete(tabId);
  };
}

export function consumedCallbackUrl(tabId: string, ...urls: (string | null | undefined)[]): boolean {
  const consume = consumers.get(tabId);
  return !!consume && urls.some((url) => !!url && consume(url));
}
