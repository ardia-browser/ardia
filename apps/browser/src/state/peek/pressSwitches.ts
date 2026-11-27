const switching = new Set<string>();

export const notePressSwitchesShownPage = (windowId: string) => void switching.add(windowId);
export const pressSwitchedShownPage = (windowId: string) => switching.delete(windowId);
