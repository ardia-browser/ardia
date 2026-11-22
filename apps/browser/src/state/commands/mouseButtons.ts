import type { MouseShortcutButton } from "../../platform/commands";
import { t } from "../../lib/uiLanguage";


export const MOUSE_BUTTONS = {
  "mouse:middle": { title: t(`Middle Click`), telemetry: "middle" },
  "mouse:4": { title: t(`Mouse Button 4`), telemetry: "button4" },
  "mouse:5": { title: t(`Mouse Button 5`), telemetry: "button5" },
} as const satisfies Record<string, { title: string; telemetry: MouseShortcutButton }>;

export type MouseButtonKey = keyof typeof MOUSE_BUTTONS;

export const isMouseKey = (key: string): key is MouseButtonKey => Object.hasOwn(MOUSE_BUTTONS, key);

export function withMouseButton(modifierText: string, key: MouseButtonKey): string {
  const title = MOUSE_BUTTONS[key].title;
  if (!modifierText) return title;
  return modifierText.endsWith("+") ? modifierText + title : `${modifierText} ${title}`;
}
