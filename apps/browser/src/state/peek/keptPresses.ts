const keeping = new Set<string>();

export const notePressKeepsPeek = (windowId: string) => void keeping.add(windowId);
export const pressKeptPeek = (windowId: string) => keeping.delete(windowId);
