import { useEffect, useRef, useState } from "react";
import type { PreviewId } from "../../../state/onboarding/previewIds";
import type { Settings } from "../../../state/settings/settings";
import { mockMotion } from "./tokens";

const PREVIEW_SETTINGS: Partial<Record<PreviewId, Partial<Settings>>> = {
  "tabs-sidebar": { tabLayout: "sidebar" },
  "tabs-top": { tabLayout: "top" },
  "address-toolbar": { addressBar: "toolbar" },
  "address-sidebar": { addressBar: "sidebar" },
  "appearance-auto": { appearance: "auto" },
  "appearance-light": { appearance: "light" },
  "appearance-dark": { appearance: "dark" },
  "sitecolor-on": { extendWebsiteColor: true },
  "sitecolor-off": { extendWebsiteColor: false },
};

const SHAPE_KEYS = ["tabLayout", "addressBar", "appearance", "extendWebsiteColor"] as const;

const withPreview = (settings: Partial<Settings>, id: PreviewId | null): Partial<Settings> => (id ? { ...settings, ...PREVIEW_SETTINGS[id] } : settings);

const sameShape = (settings: Partial<Settings>, a: PreviewId | null, b: PreviewId | null) => {
  const left = withPreview(settings, a);
  const right = withPreview(settings, b);
  return SHAPE_KEYS.every((k) => left[k] === right[k]);
};

const NO_WAIT = 0;

type Shown = { settings: PreviewId | null; scene: PreviewId | null };

export function useSceneDirector(want: PreviewId | null, settings: Partial<Settings>, group: string, settleMs: number) {
  const [shown, setShown] = useState<Shown>({ settings: want, scene: null });
  const now = useRef(shown);
  now.current = shown;
  const base = useRef(settings);
  base.current = settings;
  const wanted = useRef<{ id: PreviewId | null; group: string }>({ id: null, group });
  useEffect(() => {
    const arriving = wanted.current.id === null || wanted.current.group !== group;
    wanted.current = { id: want, group };
    const at = now.current;
    if (at.scene === want && at.settings === want) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, run: () => void) => (ms > 0 ? timers.push(setTimeout(run, ms)) : run());
    const leaving = at.scene !== null && at.scene !== want;
    if (leaving) setShown((s) => ({ ...s, scene: null }));
    later(leaving ? mockMotion.focus.duration : NO_WAIT, () => {
      const morph = !sameShape(base.current, now.current.settings, want);
      setShown((s) => ({ ...s, settings: want }));
      later(Math.max(morph ? mockMotion.move.duration : NO_WAIT, arriving ? settleMs : NO_WAIT), () => setShown({ settings: want, scene: want }));
    });
    return () => timers.forEach(clearTimeout);
  }, [want]);
  return { settings: withPreview(settings, shown.settings), scene: shown.scene };
}
