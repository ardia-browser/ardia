import { onPopupProtectedMedia, type PopupProtectedMedia } from "../../platform/performance";
import { counted, onConsentPeriodChange } from "./choice";
import { capture } from "./client";
import { nativeConsent } from "./nativeConsent";

const REFUSED = ["widevine", "playready", "fairplay", "other"] as const;
type Outcome = `${(typeof REFUSED)[number]}` | "stalled";
const OUTCOMES: readonly Outcome[] = [...REFUSED, "stalled"];

const none = () => Object.fromEntries(OUTCOMES.flatMap((outcome) => [[`${outcome}:listed`, 0], [`${outcome}:unlisted`, 0]])) as Record<string, number>;

let pending = none();

onConsentPeriodChange(() => (pending = none()));

const field = (outcome: Outcome) => (outcome === "stalled" ? "popup_protected_media_stalled" : `popup_protected_media_refused_${outcome}`);

export function notePopupProtectedMedia(media: PopupProtectedMedia | undefined) {
  const outcome: Outcome = media?.family === "none" ? "stalled" : (REFUSED.find((family) => family === media?.family) ?? "other");
  const listed = media?.listed === true ? "listed" : "unlisted";
  const key = `${outcome}:${listed}`;
  counted(
    nativeConsent(media),
    () => (pending[key] = (pending[key] ?? 0) + 1),
    () => capture("usage_counts", { [`${field(outcome)}_${listed}`]: 1 }, null),
  );
}

export const watchPopupProtectedMedia = () => onPopupProtectedMedia(notePopupProtectedMedia);

export function takePopupProtectedMediaCounts() {
  const taken = pending;
  pending = none();
  return Object.fromEntries(OUTCOMES.flatMap((outcome) => [[`${field(outcome)}_listed`, taken[`${outcome}:listed`]], [`${field(outcome)}_unlisted`, taken[`${outcome}:unlisted`]]])) as Record<string, number>;
}
