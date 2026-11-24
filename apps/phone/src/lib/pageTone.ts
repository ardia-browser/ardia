export type ToneSides = { top: string | null; bottom: string | null };

export function shownTone(live: ToneSides | null, stored: string | null): ToneSides {
  return { top: live?.top ?? stored, bottom: live?.bottom ?? stored };
}
