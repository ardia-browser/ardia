import { profileSwitcher } from "./tokens";

export const switcherCellWidth = (icon: string | null) => (icon ? profileSwitcher.iconCell : profileSwitcher.dotCell);

const switcherRowWidth = (icons: (string | null)[]) => icons.reduce((width, icon) => width + switcherCellWidth(icon), 0);

export function switcherIcons(icons: (string | null)[], shown: boolean, room: number, active: number): (string | null)[] {
  if (!shown) return icons.map(() => null);
  if (switcherRowWidth(icons) <= room) return icons;
  const activeOnly = icons.map((icon, i) => (i === active ? icon : null));
  return switcherRowWidth(activeOnly) <= room ? activeOnly : icons.map(() => null);
}
