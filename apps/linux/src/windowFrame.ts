export type WindowFrame = [number, number, number, number];
export type WorkArea = { availWidth: number; availHeight: number };

export const isWindowFrame = (value: unknown): value is WindowFrame => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite);

export function fillsScreen([, , width, height]: WindowFrame, screen: WorkArea | undefined = typeof window === "undefined" ? undefined : window.screen) {
  return !!screen && width >= screen.availWidth && height >= screen.availHeight;
}
