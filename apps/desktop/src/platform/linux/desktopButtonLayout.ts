import { hostSupports, invokeHost, reportHostError, type ArdiaHost } from "../../host.ts";
import { setDesktopButtonLayout } from "../../../../browser/src/state/windows/windowButtons.ts";
import { isTilingDesktop } from "./tilingDesktop.ts";

export const WINDOW_BUTTON_LAYOUT_METHOD = "ArdiaShell.windowButtonLayout";
const LAYOUT_EVENT = "windowButtonLayout";
const REMEMBERED_LAYOUT = "ardia.desktopButtonLayout";

type LayoutMemory = Pick<Storage, "getItem" | "setItem">;

export function reportedButtonLayout(payload: unknown): string | null | undefined {
  if (!payload || typeof payload !== "object" || !("layout" in payload)) return undefined;
  const { layout } = payload as { layout: unknown };
  return typeof layout === "string" || layout === null ? layout : undefined;
}

export const reportedDesktop = (payload: unknown): string => {
  const desktop = payload && typeof payload === "object" && "desktop" in payload ? (payload as { desktop: unknown }).desktop : undefined;
  return typeof desktop === "string" ? desktop : "";
};

function rememberedPayload(memory: LayoutMemory | undefined): unknown {
  try {
    const saved = memory?.getItem(REMEMBERED_LAYOUT);
    return saved == null ? undefined : JSON.parse(saved);
  } catch {
    return undefined;
  }
}

function remember(memory: LayoutMemory | undefined, layout: string | null, desktop: string) {
  try {
    memory?.setItem(REMEMBERED_LAYOUT, JSON.stringify({ layout, desktop }));
  } catch {}
}

const localMemory = (): LayoutMemory | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

export function followDesktopButtonLayout(host: ArdiaHost, memory: LayoutMemory | undefined = localMemory(), set: (layout: string | null, tiling: boolean) => void = setDesktopButtonLayout): () => void {
  if (!hostSupports(WINDOW_BUTTON_LAYOUT_METHOD, host)) return () => {};
  const remembered = rememberedPayload(memory);
  const rememberedLayout = reportedButtonLayout(remembered);
  if (rememberedLayout !== undefined) set(rememberedLayout, isTilingDesktop(reportedDesktop(remembered)));
  let heard = false;
  let stopped = false;
  const accept = (payload: unknown): boolean => {
    const layout = reportedButtonLayout(payload);
    if (layout === undefined) return false;
    const desktop = reportedDesktop(payload);
    set(layout, isTilingDesktop(desktop));
    remember(memory, layout, desktop);
    return true;
  };
  const stop = host.onEvent((module, event, payload) => {
    if (module === "ArdiaShell" && event === LAYOUT_EVENT && accept(payload)) heard = true;
  });
  void invokeHost(WINDOW_BUTTON_LAYOUT_METHOD, { args: [] }, host).then((payload) => {
    if (!heard && !stopped) accept(payload);
  }, reportHostError);
  return () => {
    stopped = true;
    stop();
  };
}
