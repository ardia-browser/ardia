import { parseRememberedTones, rememberedTonesText } from "../../lib/toneMemory";
import { readPreferences, writePreference } from "../store/browserDatabase";
import { tabDatabase } from "../store/database";
import { usePages } from "./store";

const TONES_KEY = "pageTones";
const WRITE_DELAY_MS = 1500;

let stopRemembering: (() => void) | null = null;

export function restorePageTones(keep: ReadonlySet<string>) {
  let remembered = {};
  try {
    remembered = parseRememberedTones(readPreferences(tabDatabase())[TONES_KEY], keep);
  } catch {
    return;
  }
  usePages.setState((s) => ({ lastTones: { ...remembered, ...s.lastTones } }));
}

export function rememberPageTones(keep: () => ReadonlySet<string>): () => void {
  stopRemembering?.();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const write = () => {
    timer = null;
    try {
      writePreference(tabDatabase(), TONES_KEY, rememberedTonesText(usePages.getState().lastTones, keep()));
    } catch {
      return;
    }
  };
  const unsubscribe = usePages.subscribe((state, previous) => {
    if (state.lastTones === previous.lastTones || timer) return;
    timer = setTimeout(write, WRITE_DELAY_MS);
  });
  const stop = () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    if (stopRemembering === stop) stopRemembering = null;
  };
  stopRemembering = stop;
  return stop;
}
