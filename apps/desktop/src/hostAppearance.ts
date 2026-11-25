import { hostSupports, invokeHost, type ArdiaHost } from "./host.ts";

export type AppearanceMode = "auto" | "light" | "dark";
export const SET_APPEARANCE_METHOD = "ArdiaShell.setAppearance";
export const IS_DARK_APPEARANCE_METHOD = "ArdiaShell.isDarkAppearance";

type DarkQuery = {
  readonly matches: boolean;
  addEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
} | null;

export function createAppearance(host: ArdiaHost | undefined, darkQuery: DarkQuery, emit: (dark: boolean) => void) {
  const engineApplies = !!host && hostSupports(SET_APPEARANCE_METHOD, host);
  let mode: AppearanceMode = "auto";
  const isDarkAppearance = async () => {
    if (engineApplies) return (await invokeHost<boolean>(IS_DARK_APPEARANCE_METHOD, { args: [] }, host)) === true;
    return mode === "auto" ? !!darkQuery?.matches : mode === "dark";
  };
  const setAppearance = async (next: AppearanceMode) => {
    if (next === mode) return;
    const previous = mode;
    mode = next;
    if (engineApplies) {
      try {
        await invokeHost(SET_APPEARANCE_METHOD, { args: [next] }, host);
      } catch (error) {
        if (mode === next) mode = previous;
        throw error;
      }
    }
    emit(await isDarkAppearance());
  };
  darkQuery?.addEventListener("change", (event) => {
    if (engineApplies || mode === "auto") emit(event.matches);
  });
  return { setAppearance, isDarkAppearance };
}
