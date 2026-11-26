export const OUTRO_COMMANDS = ["newTab", "focusCommandBar", "toggleSidebar"] as const;

export type OutroCommand = (typeof OUTRO_COMMANDS)[number];

const LABELS: Record<OutroCommand, string> = {
  newTab: "Open a new tab",
  focusCommandBar: "Go anywhere from the command bar",
  toggleSidebar: "Hide the sidebar for more room",
};

export function outroShortcuts(hints: Readonly<Record<OutroCommand, string | undefined>>): { command: OutroCommand; keys: string; label: string }[] {
  const shown = new Set<string>();
  return OUTRO_COMMANDS.flatMap((command) => {
    const keys = hints[command];
    if (!keys || shown.has(keys)) return [];
    shown.add(keys);
    return [{ command, keys, label: LABELS[command] }];
  });
}
