import { pluginInstallLink } from "../../lib/pluginIds";

const MAX_WAITING = 8;

let handle: ((id: string) => boolean) | null = null;
const waiting: string[] = [];

export function handlePluginInstallLinks(handler: (id: string) => boolean) {
  handle = handler;
  for (const id of waiting.splice(0)) handler(id);
}

export function takePluginInstallLinks(urls: readonly string[]): string[] {
  return urls.filter((url) => {
    const id = pluginInstallLink(url);
    if (id === null) return true;
    if (handle) handle(id);
    else if (waiting.length < MAX_WAITING && !waiting.includes(id)) waiting.push(id);
    return false;
  });
}

export function resetInstallLinksForTests() {
  handle = null;
  waiting.length = 0;
}
