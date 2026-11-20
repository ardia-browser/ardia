export type LibraryItemAction = { name: string; label: string; run: () => void };

const MORE_ACTIONS = { name: "menu", label: "More Actions" } as const;
const ONLY_MORE = [MORE_ACTIONS];

export const accessibilityActionsOf = (actions: readonly LibraryItemAction[] | undefined) =>
  actions?.length ? [...actions.map(({ name, label }) => ({ name, label })), MORE_ACTIONS] : ONLY_MORE;

export function runAccessibilityAction(name: string, actions: readonly LibraryItemAction[] | undefined, openMenu: () => void) {
  if (name === MORE_ACTIONS.name) return openMenu();
  actions?.find((action) => action.name === name)?.run();
}
