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

type Grant = { frameToken: string; processId: number; routingId: number; origin: string; kind: AutofillKind; ids: Set<string>; at: number };

const GRANT_KEPT_MS = 10 * 60_000;
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

export class FillGrants {
  private readonly byContents = new Map<number, Map<string, Grant>>();

  offer(contentsId: number, frame: AutofillFrame, kind: AutofillKind, ids: string[], now = Date.now()): void {
    const grants = this.byContents.get(contentsId) ?? new Map<string, Grant>();
    this.byContents.set(contentsId, grants);
    if (!ids.length) {
      grants.delete(frame.frameToken);
      return;
    }
    grants.set(frame.frameToken, { frameToken: frame.frameToken, processId: frame.processId, routingId: frame.routingId, origin: frame.origin, kind, ids: new Set(ids), at: now });
  }

  take(contentsId: number, frame: AutofillFrame | null | undefined, kind: AutofillKind, id: string, now = Date.now()): boolean {
    if (!live(frame) || !frameAllows(frame, kind)) return false;
    const grants = this.byContents.get(contentsId);
    const grant = grants?.get(frame.frameToken);
    if (!grants || !grant) return false;
    grants.delete(frame.frameToken);
    return grant.kind === kind && grant.origin === frame.origin && grant.processId === frame.processId && grant.routingId === frame.routingId && grant.ids.has(id) && now - grant.at <= GRANT_KEPT_MS;
  }

  forgetFrame(contentsId: number, processId: number, routingId: number): void {
    const grants = this.byContents.get(contentsId);
    if (!grants) return;
    for (const [token, grant] of grants) if (grant.processId === processId && grant.routingId === routingId) grants.delete(token);
  }

  forgetContents(contentsId: number): void {
    this.byContents.delete(contentsId);
  }
}
