import { isFields } from "./decode";
import type { ProfileTheme } from "./profileLook";

export type ThemeEdit = { theme: ProfileTheme | null; target: string };

type Deps = {
  apply: (theme: ProfileTheme | null, final: boolean) => void;
  showing: () => string;
  current: () => unknown;
  same?: (a: unknown, b: unknown) => boolean;
  draft: (edit: ThemeEdit | null) => void;
  requestFrame: (run: () => void) => number;
  cancelFrame: (handle: number) => void;
};

const presentKeys = (fields: Record<string, unknown>) => Object.keys(fields).filter((key) => fields[key] !== undefined);

export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => sameData(value, b[i]));
  if (!isFields(a) || !isFields(b)) return false;
  const keys = presentKeys(a);
  return keys.length === presentKeys(b).length && keys.every((key) => b[key] !== undefined && sameData(a[key], b[key]));
}

export function themeGesture(deps: Deps) {
  const same = deps.same ?? Object.is;
  let pending: ThemeEdit | undefined;
  let frame: number | null = null;
  let gesture: string | null = null;
  let cancelled = false;
  let expected: unknown;
  const stopFrame = () => {
    if (frame !== null) deps.cancelFrame(frame);
    frame = null;
  };
  const flush = (final = false) => {
    frame = null;
    const edit = pending;
    pending = undefined;
    if (!edit) return;
    if (edit.target !== deps.showing() || !same(deps.current(), expected)) {
      cancelled = true;
      deps.draft(null);
      return;
    }
    deps.apply(edit.theme, final);
    expected = deps.current();
  };
  const drop = () => {
    stopFrame();
    pending = undefined;
    deps.draft(null);
  };
  return {
    begin(target: string) {
      if (gesture === null) expected = deps.current();
      gesture ??= target;
    },
    change(theme: ProfileTheme | null, target: string, settle = false) {
      if (gesture === null) expected = deps.current();
      gesture ??= target;
      if (cancelled || gesture !== target || deps.showing() !== target) {
        drop();
        cancelled = true;
        if (settle) {
          gesture = null;
          cancelled = false;
        }
        return;
      }
      pending = { theme, target };
      deps.draft(settle ? null : pending);
      if (settle) {
        stopFrame();
        flush(true);
        gesture = null;
        cancelled = false;
      } else if (frame === null) frame = deps.requestFrame(() => flush());
    },
    selectionChanged() {
      if (gesture === null) return;
      drop();
      cancelled = true;
    },
    cancel() {
      drop();
      cancelled = gesture !== null;
      if (!cancelled) gesture = null;
    },
    dispose: stopFrame,
  };
}
