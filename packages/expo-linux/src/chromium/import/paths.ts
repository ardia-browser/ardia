const known = new Set<string>();

export const pathExists = (path: string): boolean => known.has(path);

export function knowExistingPaths(paths: readonly string[]): void {
  known.clear();
  for (const path of paths) known.add(path);
}
