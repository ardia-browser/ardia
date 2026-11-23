export const TOOLBAR_ACTIONS = ["bookmark", "copyUrl"] as const;
export type ToolbarAction = (typeof TOOLBAR_ACTIONS)[number];

export const TOOLBAR_LAYOUTS: readonly (readonly ToolbarAction[])[] = [
  [], ["bookmark"], ["copyUrl"], ["bookmark", "copyUrl"], ["copyUrl", "bookmark"],
];

export function normalizeToolbarActions(value: unknown): ToolbarAction[] | null {
  if (!Array.isArray(value)) return null;
  const valid = TOOLBAR_LAYOUTS.some((layout) => layout.length === value.length && layout.every((action, index) => action === value[index]));
  return valid ? value : null;
}

export function addressBarButtons(pinned: ToolbarAction[] | null, bookmarks: boolean, hovered: boolean): ToolbarAction[] {
  if (pinned === null) return hovered ? [bookmarks ? "bookmark" : "copyUrl"] : [];
  return bookmarks ? pinned : pinned.filter((action) => action !== "bookmark");
}
