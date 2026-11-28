import { create } from "zustand";
import type { PageBarShown } from "./placement";

export type { PageBarShown };

export type ToastIcon = "checkmark" | "warning" | "download" | "blocking" | "link" | "laptop" | "star" | "sent" | "calculation" | "iphone" | "swipe";

export type ToastAction = { label: string; run: () => void; quiet?: boolean };

export type ToastTile = { kind: "file"; ext: string } | { kind: "icon"; icon: ToastIcon } | { kind: "count"; count: number };

export type ToastCard = {
  key?: string;
  title: string;
  detail?: string | null;
  tile?: ToastTile;
  icon?: ToastIcon;
  action?: ToastAction | null;
  progress?: number | null;
  durationMs?: number;
  titleLines?: number;
  stage?: string;
  spoken?: string;
};

export type Toast = {
  id: number;
  key: string;
  title: string;
  message: string;
  detail: string | null;
  icon: ToastIcon;
  tile: ToastTile;
  action: ToastAction | null;
  showsProgress: boolean;
  progress: number | null;
  durationMs: number;
  titleLines: number;
  middleTruncates: boolean;
  stage: string;
  spoken: string;
};

export const TOAST_DURATION_MS = 2400;
export const TOAST_LONG_DURATION_MS = 3200;
export const TOAST_ACTION_DURATION_MS = 5000;
export const TOAST_TITLE_LINES = 3;

export const useToasts = create<{ toast: Toast | null; barTopY: number | null; pageBar: PageBarShown }>()(() => ({ toast: null, barTopY: null, pageBar: "full" }));

export const noteDeckBarTop = (barTopY: number | null) => {
  if (useToasts.getState().barTopY !== barTopY) useToasts.setState({ barTopY });
};

export const notePageBar = (pageBar: PageBarShown) => {
  if (useToasts.getState().pageBar !== pageBar) useToasts.setState({ pageBar });
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

const spokenText = (title: string, detail: string | null) => (detail ? `${title}, ${detail}` : title);

export function toastDuration(requested: number | undefined, action: ToastAction | null): number {
  const asked = requested ?? (action ? TOAST_ACTION_DURATION_MS : TOAST_DURATION_MS);
  return action ? Math.max(asked, TOAST_ACTION_DURATION_MS) : asked;
}

export function toastFromCard(card: ToastCard, id: number): Toast {
  const action = card.action ?? null;
  const tile: ToastTile = card.tile ?? { kind: "icon", icon: card.icon ?? "checkmark" };
  const icon = card.icon ?? (tile.kind === "icon" ? tile.icon : "download");
  const detail = card.detail ?? null;
  const fileTitle = tile.kind === "file";
  const titleLines = card.titleLines ?? (fileTitle ? 1 : TOAST_TITLE_LINES);
  return {
    id,
    key: card.key ?? card.title,
    title: card.title,
    message: card.title,
    detail,
    icon,
    tile,
    action,
    showsProgress: card.progress !== undefined,
    progress: card.progress ?? null,
    durationMs: toastDuration(card.durationMs, action),
    titleLines,
    middleTruncates: fileTitle && titleLines === 1,
    stage: card.stage ?? "",
    spoken: card.spoken ?? spokenText(card.title, detail),
  };
}

export function showToast(card: ToastCard): void;
export function showToast(message: string, icon: ToastIcon, durationMs?: number, action?: ToastAction | null): void;
export function showToast(messageOrCard: string | ToastCard, icon: ToastIcon = "checkmark", durationMs?: number, action: ToastAction | null = null) {
  const card: ToastCard = typeof messageOrCard === "string" ? { title: messageOrCard, icon, tile: { kind: "icon", icon }, durationMs, action } : messageOrCard;
  const showing = useToasts.getState().toast;
  const key = card.key ?? card.title;
  if (showing && showing.key === key) {
    const updated = toastFromCard(card, showing.id);
    useToasts.setState({ toast: updated });
    scheduleDismissal(showing.id, updated.durationMs);
    return;
  }
  next += 1;
  const id = next;
  measureDeckBar?.();
  const made = toastFromCard(card, id);
  useToasts.setState({ toast: made });
  scheduleDismissal(id, made.durationMs);
}

export function updateToast(key: string, patch: Partial<ToastCard>): boolean {
  const showing = useToasts.getState().toast;
  if (!showing || showing.key !== key) return false;
  const detail = patch.detail !== undefined ? patch.detail : showing.detail;
  const title = patch.title ?? showing.title;
  const updated: Toast = {
    ...showing,
    title,
    message: title,
    detail,
    progress: patch.progress !== undefined ? patch.progress : showing.progress,
    showsProgress: patch.progress !== undefined ? true : showing.showsProgress,
    spoken: patch.spoken ?? (showing.spoken === spokenText(showing.title, showing.detail) ? spokenText(title, detail) : showing.spoken),
  };
  useToasts.setState({ toast: updated });
  scheduleDismissal(showing.id, showing.durationMs);
  return true;
}

export const currentToastKey = () => useToasts.getState().toast?.key ?? null;

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
  toast?.action?.run();
}

export const dismissToast = () => {
  held = false;
  if (timer) clearTimeout(timer);
  timer = null;
  useToasts.setState({ toast: null });
};
