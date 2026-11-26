import type { ResolvedShortcuts } from "./shortcuts";

export const conflictTitles = (resolved: ResolvedShortcuts, items: readonly { id: string; title: string }[], id: string): string[] =>
  resolved.conflictsOf(id).flatMap((other) => items.find((item) => item.id === other)?.title ?? []);

export const conflictMessage = (titles: readonly string[]) =>
  `${titles.length === 1 ? "This shortcut conflicts with another shortcut:" : "This shortcut conflicts with other shortcuts:"} ${titles.join(", ")}`;
