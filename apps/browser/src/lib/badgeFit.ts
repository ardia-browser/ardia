type BadgeFit = { pad: number; scale: number };

type BadgeFitInput = { textWidth: number; room: number; roomyPad: number; tightPad: number; minScale: number };

const SHRINK_SLACK = 1;

export function badgeFit({ textWidth, room, roomyPad, tightPad, minScale }: BadgeFitInput): BadgeFit {
  if (textWidth + 2 * roomyPad <= room) return { pad: roomyPad, scale: 1 };
  const tightRoom = room - 2 * tightPad;
  if (textWidth <= tightRoom) return { pad: tightPad, scale: 1 };
  return { pad: tightPad, scale: Math.max(minScale, (tightRoom - SHRINK_SLACK) / textWidth) };
}

export type MeasuredBadgeText = { text: string; fontSize: number; width: number };

export function badgeTextWidth(measured: MeasuredBadgeText, text: string, fontSize: number): number {
  if (measured.text === text && measured.fontSize === fontSize) return measured.width;
  if (!measured.text.length || !measured.fontSize) return 0;
  return measured.width * (text.length / measured.text.length) * (fontSize / measured.fontSize);
}
