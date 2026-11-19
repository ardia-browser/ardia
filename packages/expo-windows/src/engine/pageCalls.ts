export type PageCall = <Result = unknown>(key: string, method: string, args: Record<string, unknown>) => Promise<Result | null>;
type Reply = Record<string, unknown> | null;

const ARGUMENTS: Record<string, string[]> = {
  loadUrl: ["url", "userInitiated"],
  goBack: [],
  goForward: [],
  goToOffset: ["offset"],
  reload: [],
  reloadToPlay: [],
  forceReload: [],
  stopLoading: [],
  focus: [],
  setMuted: ["muted"],
  find: ["text", "forward", "findNext"],
  stopFinding: ["clear"],
  zoomStep: ["direction"],
  executeJavaScript: ["code"],
  evaluate: ["code"],
  navigationEntries: [],
  showDevTools: ["panel"],
  print: [],
  runPageCommand: ["name"],
  getSecurityInfo: [],
  mediaCommand: ["action", "seconds"],
  downloadImage: ["url", "maxPixels"],
  clearSiteData: [],
  pageCookies: ["urls"],
  openBlockedPopup: ["id", "always"],
  discard: ["unload"],
  sleepIfHidden: ["seconds"],
  setFrozen: ["frozen"],
  resolveUnresponsive: ["terminate"],
};
const UNWRAPPED: Record<string, (reply: Reply) => unknown> = {
  evaluate: (reply) => reply?.result ?? null,
  navigationEntries: (reply) => reply?.entries ?? [],
  pageCookies: (reply) => reply?.cookies ?? [],
  discard: (reply) => reply?.outcome ?? "refused",
  sleepIfHidden: (reply) => (Array.isArray(reply?.keptBy) ? reply.keptBy : [-1]),
  getSecurityInfo: (reply) => (!reply || reply.info === null ? null : reply),
  clearSiteData: (reply) => reply ?? { cookies: false, storage: false },
  downloadImage: (reply) => (typeof reply?.uri === "string" ? { uri: reply.uri, width: Number(reply.width) || 0, height: Number(reply.height) || 0 } : null),
  mediaCommand: (reply) => (reply ? { done: reply.done === true, ...(reply.byScript === true ? { byScript: true } : {}), ...(reply.recorded === true ? { recorded: true } : {}) } : null),
};
export const MISSING_ANSWERS: Record<string, unknown> = {
  requestPictureInPicture: false,
  takeControlPress: false,
};
const REFUSALS_ANSWER_NOTHING = new Set(["mediaCommand"]);

export function pageMethod(call: PageCall, key: string, method: string): ((...values: unknown[]) => Promise<unknown>) | null {
  const names = ARGUMENTS[method];
  if (!names) return null;
  const unwrap = UNWRAPPED[method];
  return async (...values: unknown[]) => {
    const asked = call<Record<string, unknown>>(key, method, Object.fromEntries(names.map((name, index) => [name, values[index] ?? null])));
    const reply = await (REFUSALS_ANSWER_NOTHING.has(method) ? asked.catch(() => null) : asked);
    return unwrap ? unwrap(reply) : undefined;
  };
}
