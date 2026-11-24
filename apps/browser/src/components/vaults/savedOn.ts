import { useEffect, useState } from "react";
import type { SavedPassword } from "../../state/site/passwords";

export type SavedOn = (origin: string) => Promise<readonly SavedPassword[]>;

const NO_SAVED: readonly SavedPassword[] = [];

export function useSavedOn(lookup: SavedOn | null, origin: string | null) {
  const [near, setNear] = useState<{ origin: string; saved: readonly SavedPassword[] } | null>(null);
  useEffect(() => {
    if (!lookup || !origin) return;
    let live = true;
    void lookup(origin).then(
      (saved) => live && setNear({ origin, saved }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [origin]);
  const shown = near && near.origin === origin ? near.saved : NO_SAVED;
  const loaded = async (wanted: string) => (near?.origin === wanted ? near.saved : lookup ? await lookup(wanted).catch(() => NO_SAVED) : NO_SAVED);
  return { shown, loaded };
}
