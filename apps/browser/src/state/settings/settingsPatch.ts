import { noteSettingsWritesRejected } from "../telemetry/settingsWriteCounts";

type Specs = Record<string, { valid: (value: unknown) => boolean }>;

export function checkedSettingsPatch<P extends object>(patch: P, specs: Specs): { patch: P; rejected: string[] } {
  const entries = Object.entries(patch);
  const rejected = entries.flatMap(([key, value]) => (Object.hasOwn(specs, key) && specs[key]!.valid(value) ? [] : [key]));
  if (!rejected.length) return { patch, rejected };
  noteSettingsWritesRejected(rejected.length);
  return { patch: Object.fromEntries(entries.filter(([key]) => !rejected.includes(key))) as P, rejected };
}

export const keptSettingsPatch = <P extends object>(patch: P, specs: Specs): P => checkedSettingsPatch(patch, specs).patch;

type FrameSettings = { pageFrameZeroInFullScreen: boolean; pageFrameZeroWhenTabsHidden: boolean };

export function settledPatch<S extends FrameSettings>(settings: S, raw: Partial<S>, specs: Specs): Partial<S> {
  const patch = keptSettingsPatch(raw, specs);
  const next = { ...settings, ...patch };
  const zeroWhenTabsHidden = next.pageFrameZeroInFullScreen && !next.pageFrameZeroWhenTabsHidden && !("pageFrameZeroWhenTabsHidden" in patch);
  return zeroWhenTabsHidden ? { ...patch, pageFrameZeroWhenTabsHidden: true } : patch;
}
