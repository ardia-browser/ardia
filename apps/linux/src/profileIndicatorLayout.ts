const PAD = 5;
const MIN_CUT_NAME = 52;
const ICON_WIDTH = 32;
const MENU_WIDTH = 32;
const GAP = 2;

function indicatorWithMenu({ room, textWidth, named }: { room: number; textWidth: number | undefined; named: boolean }) {
  const nameRoom = room - MENU_WIDTH - GAP;
  const shown = named && nameRoom >= ICON_WIDTH;
  const textRoom = nameRoom - 2 * PAD;
  const showName = shown && !!textWidth && (textWidth <= textRoom || textRoom >= MIN_CUT_NAME);
  const nameWidth = !shown ? 0 : showName ? Math.min(nameRoom, textWidth + 2 * PAD) : ICON_WIDTH;
  return { shown, showName, nameWidth, width: Math.max(0, Math.min(room, nameWidth + (shown ? GAP : 0) + MENU_WIDTH)) };
}

export function headerIndicatorLayout({ room, textWidth, named, menuInHeader }: { room: number; textWidth: number | undefined; named: boolean; menuInHeader: boolean }) {
  if (menuInHeader) return { ...indicatorWithMenu({ room, textWidth, named }), menuInHeader };
  const layout = indicatorWithMenu({ room: room + MENU_WIDTH + GAP, textWidth, named });
  return { ...layout, menuInHeader, width: layout.shown ? layout.nameWidth : 0 };
}

export const HEADER_MENU = { width: MENU_WIDTH, height: 34 } as const;

const CONTROLS_GAP = 3;

export function sidebarHeaderSplit({ width, captionRoom, controls, toggleOnly, menuInHeader, slot }: { width: number; captionRoom: number; controls: number; toggleOnly: number; menuInHeader: boolean; slot: { edge: number; button: number; pitch: number } }) {
  if (menuInHeader) {
    const menuCenter = width - slot.edge - slot.button / 2;
    return { tools: true, navigation: Math.max(toggleOnly, width - slot.pitch), menuLeft: Math.max(toggleOnly, menuCenter - MENU_WIDTH / 2) };
  }
  if (captionRoom && width - controls - CONTROLS_GAP < toggleOnly) return { tools: false, navigation: 0, menuLeft: 0 };
  return { tools: true, navigation: width - captionRoom, menuLeft: 0 };
}
