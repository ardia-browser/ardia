export const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function spokenList(items: readonly string[]): string {
  if (items.length < 3) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
