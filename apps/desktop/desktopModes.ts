export const DESKTOP_MODES = ["linux", "win", "mac"] as const;

export type DesktopMode = (typeof DESKTOP_MODES)[number];

export function desktopMode(mode: string | undefined): DesktopMode {
  const known = DESKTOP_MODES.find((candidate) => candidate === mode);
  if (!known) throw new Error(`apps/desktop builds for --mode ${DESKTOP_MODES.join(" or --mode ")}, not ${mode === undefined ? "no mode" : `--mode ${mode}`}`);
  return known;
}

export const platformSuffixes = (mode: DesktopMode): readonly string[] => [`.${mode}`, ".desktop"];

export const outDirFor = (mode: DesktopMode) => `dist/${mode}`;
