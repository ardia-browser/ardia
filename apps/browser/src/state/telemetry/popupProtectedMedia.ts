import { onPopupProtectedMedia, type PopupProtectedMedia } from "../../platform/performance";
import { isSharing, useTelemetry } from "./choice";

const REFUSED = ["widevine", "playready", "fairplay", "other"] as const;
type Outcome = `${(typeof REFUSED)[number]}` | "stalled";
const OUTCOMES: readonly Outcome[] = [...REFUSED, "stalled"];

const none = () => Object.fromEntries(OUTCOMES.flatMap((outcome) => [[`${outcome}:listed`, 0], [`${outcome}:unlisted`, 0]])) as Record<string, number>;

let pending = none();

useTelemetry.subscribe((current, previous) => {
  if (current.sharing !== previous.sharing) pending = none();
});

export function notePopupProtectedMedia(media: PopupProtectedMedia | undefined) {
  if (!isSharing()) return;
  const outcome: Outcome = media?.family === "none" ? "stalled" : (REFUSED.find((family) => family === media?.family) ?? "other");
  const key = `${outcome}:${media?.listed === true ? "listed" : "unlisted"}`;
  pending[key] = (pending[key] ?? 0) + 1;
}

export const watchPopupProtectedMedia = () => onPopupProtectedMedia(notePopupProtectedMedia);

export function takePopupProtectedMediaCounts() {
  const taken = pending;
  pending = none();
  const field = (outcome: Outcome) => (outcome === "stalled" ? "popup_protected_media_stalled" : `popup_protected_media_refused_${outcome}`);
  return Object.fromEntries(OUTCOMES.flatMap((outcome) => [[`${field(outcome)}_listed`, taken[`${outcome}:listed`]], [`${field(outcome)}_unlisted`, taken[`${outcome}:unlisted`]]])) as Record<string, number>;
}
