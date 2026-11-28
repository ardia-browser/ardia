let own: string | null = null;

export const setStripOwner = (windowId: string | null) => void (own = windowId);

export const isForeignStrip = (strip: { appWindow?: string }) => own !== null && !!strip.appWindow && strip.appWindow !== own;
