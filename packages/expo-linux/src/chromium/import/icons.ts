const found = new Map<string, string>();

const keyOf = (names: readonly string[]) => names.join("\n");

export const browserIcon = (_home: string, names: string[]): string | null => found.get(keyOf(names)) ?? null;

export function knowBrowserIcons(names: readonly (readonly string[])[], paths: readonly (string | null | undefined)[]): void {
  found.clear();
  names.forEach((each, index) => {
    const path = paths[index];
    if (path) found.set(keyOf(each), path);
  });
}
