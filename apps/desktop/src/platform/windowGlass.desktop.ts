import type { BackdropThemeSource } from "../backdropTheme";

export const behindWindowGlassAvailable = (): boolean => false;

export const nativeWindowBackdrop = (): boolean => false;

export const refreshBehindWindowGlass = (): void => {};

export const watchBehindWindowGlass = (_element: HTMLElement, _theme: BackdropThemeSource | null = null): (() => void) => () => {};
