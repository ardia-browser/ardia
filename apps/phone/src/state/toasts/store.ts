import { create } from "zustand";

export type ToastIcon = "checkmark" | "warning" | "download" | "blocking" | "link" | "laptop" | "star" | "sent" | "calculation" | "iphone" | "swipe";

export type Toast = { id: number; message: string; icon: ToastIcon; durationMs: number; onTap: (() => void) | null };

export const TOAST_DURATION_MS = 2400;
export const TOAST_LONG_DURATION_MS = 3200;

export const useToasts = create<{ toast: Toast | null; barTopY: number | null }>()(() => ({ toast: null, barTopY: null }));

export const noteDeckBarTop = (barTopY: number | null) => {
  if (useToasts.getState().barTopY !== barTopY) useToasts.setState({ barTopY });
};

let measureDeckBar: (() => void) | null = null;

export function watchDeckBar(measure: (() => void) | null) {
  measureDeckBar = measure;
  if (!measure) noteDeckBarTop(null);
}

let next = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

export const TOAST_RELEASE_MS = 1200;

let held = false;

function scheduleDismissal(id: number, durationMs: number) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (held) return;
  timer = setTimeout(() => {
    if (useToasts.getState().toast?.id === id) useToasts.setState({ toast: null });
  }, durationMs);
}

export function showToast(message: string, icon: ToastIcon, durationMs = TOAST_DURATION_MS, onTap: (() => void) | null = null) {
  const showing = useToasts.getState().toast;
  if (showing && showing.message === message) {
    scheduleDismissal(showing.id, durationMs);
    return;
  }
  next += 1;
  const id = next;
  measureDeckBar?.();
  useToasts.setState({ toast: { id, message, icon, durationMs, onTap } });
  scheduleDismissal(id, durationMs);
}

export function holdToast(holding: boolean) {
  const showing = useToasts.getState().toast;
  if (!showing) return;
  held = holding;
  if (holding) {
    if (timer) clearTimeout(timer);
    timer = null;
  } else scheduleDismissal(showing.id, TOAST_RELEASE_MS);
}

export function tapToast() {
  const toast = useToasts.getState().toast;
  useToasts.setState({ toast: null });
  toast?.onTap?.();
}

export const dismissToast = () => {
  held = false;
  if (timer) clearTimeout(timer);
  timer = null;
  useToasts.setState({ toast: null });
};
