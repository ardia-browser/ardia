export type AutofillKind = "address" | "card";

export type AutofillFrame = {
  readonly origin: string;
  readonly frameToken: string;
  readonly processId: number;
  readonly routingId: number;
  readonly top: AutofillFrame | null;
  readonly detached?: boolean;
  isDestroyed(): boolean;
};

const WEB_ORIGIN = /^https?:\/\/[^/]+$/;
const LOCAL_HOST = /^(localhost|[^/]+\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

export const isAutofillKind = (kind: unknown): kind is AutofillKind => kind === "address" || kind === "card";

export function isSecureOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOST.test(url.hostname));
}

const live = (frame: AutofillFrame | null | undefined): frame is AutofillFrame => !!frame && !frame.isDestroyed() && !frame.detached;

export function frameAllows(frame: AutofillFrame | null | undefined, kind: AutofillKind): boolean {
  if (!live(frame)) return false;
  const top = frame.top ?? frame;
  if (!WEB_ORIGIN.test(frame.origin) || frame.origin !== top.origin) return false;
  return kind === "address" || isSecureOrigin(frame.origin);
}
