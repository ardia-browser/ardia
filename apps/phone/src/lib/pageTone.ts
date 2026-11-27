export type ToneSides = { top: string | null; bottom: string | null };

export function shownTone(live: ToneSides | null, stored: string | null): ToneSides {
  return { top: live?.top ?? stored, bottom: live?.bottom ?? stored };
}

export type BarToneInputs = { design: string; glassTone: boolean | undefined; toneBottom: string | null | undefined; themeDark: boolean; bottomDark: boolean };

export function barIsDark({ design, glassTone, toneBottom, themeDark, bottomDark }: BarToneInputs): boolean {
  if (design === "redesigned" && glassTone !== undefined) return glassTone;
  return (design === "redesigned" || design === "material") && !toneBottom ? themeDark : bottomDark;
}

export type PageBarInputs = BarToneInputs & { incognitoLook: boolean; os: string; nativeGlass: boolean };

export const pageBarDark = ({ incognitoLook, os, nativeGlass, ...tone }: PageBarInputs): boolean => (tone.design === "redesigned" && nativeGlass && os === "android" && incognitoLook) || barIsDark(tone);
