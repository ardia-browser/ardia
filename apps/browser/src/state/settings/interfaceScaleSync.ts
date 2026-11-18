import { nativeInterfaceScale, setNativeInterfaceScale } from "../../platform/app";
import { INTERFACE_SCALE, sameInterfaceScale } from "../../lib/interfaceScale";
import { useBrowser, type BrowserState } from "../browser/store";
import { appliedInterfaceScale, currentInterfaceScale } from "./interfaceScale";

export const storedScaleWins = (s: Pick<BrowserState, "settings" | "settingsMeta">): boolean =>
  s.settingsMeta.chosen.includes("interfaceScale") || s.settings.interfaceScale !== INTERFACE_SCALE.default;

let stop: (() => void) | null = null;
let asked: number | null = null;
let refused: number | null = null;

function push(scale: number) {
  asked = scale;
  refused = null;
  setNativeInterfaceScale(scale).then(
    (now) => {
      if (asked === scale) appliedInterfaceScale(now);
    },
    (error: unknown) => {
      if (asked === scale) refused = scale;
      console.warn("[interfaceScale] couldn't apply the interface size", error);
    },
  );
}

export function startInterfaceScale(): () => void {
  if (stop) return stop;
  const native = nativeInterfaceScale();
  appliedInterfaceScale(native);
  const s = useBrowser.getState();
  if (storedScaleWins(s) && !sameInterfaceScale(s.settings.interfaceScale, native)) push(s.settings.interfaceScale);
  const unsubscribe = useBrowser.subscribe((next, prev) => {
    if (!storedScaleWins(next)) return;
    const wanted = next.settings.interfaceScale;
    const retry = refused !== null && sameInterfaceScale(wanted, refused) && next.settings !== prev.settings;
    if (retry || !sameInterfaceScale(wanted, asked ?? currentInterfaceScale())) push(wanted);
  });
  stop = () => {
    unsubscribe();
    asked = null;
    refused = null;
    stop = null;
  };
  return stop;
}
