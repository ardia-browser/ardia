const paths = new Set<string>();

export const rememberOffTheRecordPath = (path: string) => void (path && paths.add(path));

export const isOffTheRecordPath = (path: string): boolean => paths.has(path);
