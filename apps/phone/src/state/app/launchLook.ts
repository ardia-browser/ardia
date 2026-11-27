import { useEffect, useMemo } from "react";
import { launchLookFor, launchLookWriter } from "../../lib/launchLook";
import type { ProfileLook } from "../../lib/profileLook";
import { rememberLaunchLook } from "../../platform/look";
import { usePreferredScheme } from "../settings/appearance";
import { useThemeDraft } from "../settings/themeDraft";

const writer = launchLookWriter((saved) => {
  rememberLaunchLook(saved);
});

export const rememberLaunchLookOnLeaving = () => writer.leave();

export function useLaunchLook(look: ProfileLook, ready: boolean) {
  const preferred = usePreferredScheme();
  const drafting = useThemeDraft((s) => s.draft !== null);
  const saved = useMemo(() => launchLookFor(look, preferred), [look, preferred]);
  useEffect(() => {
    if (ready && !drafting) writer.settle(saved);
  }, [ready, drafting, saved]);
}
