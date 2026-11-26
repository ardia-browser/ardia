const latestOpens = new Map<string, number>();

export function beginAppMenuOpen(windowId: string): () => boolean {
  const token = (latestOpens.get(windowId) ?? 0) + 1;
  latestOpens.set(windowId, token);
  return () => latestOpens.get(windowId) === token;
}

export const mayPublishAppMenu = (current: () => boolean, anchor: { isConnected: boolean }) => current() && anchor.isConnected;
