const keys = new Set<string>();

export const markMaterialized = (key: string) => void keys.add(key);

export const isMaterialized = (key: string | null | undefined): boolean => !!key && keys.has(key);
