import { onAppEvent, type AppEvent } from "../../platform/app";
import { capture } from "./client";

export type PasteRefusedEvent = Extract<AppEvent, { type: "pasteRefused" }>;

const REASONS = new Set([
  "deadline",
  "cancelled",
  "superseded",
  "stale_epoch",
  "queue_full",
  "no_origin",
  "late_acknowledgement",
  "focus_lost",
  "mouse_down",
  "window_left",
  "no_text",
  "deferred",
  "refused",
]);

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const STANDARD_TYPES = new Set([
  "public.utf8-plain-text",
  "public.utf16-plain-text",
  "public.utf16-external-plain-text",
  "public.plain-text",
  "public.utf8-tab-separated-values-text",
  "public.html",
  "public.rtf",
  "public.url",
  "public.url-name",
  "public.file-url",
  "public.png",
  "public.jpeg",
  "public.tiff",
  "public.heic",
  "com.adobe.pdf",
  "com.apple.webarchive",
  "com.apple.flat-rtfd",
  "org.chromium.web-custom-data",
  "org.chromium.source-url",
  "NSStringPboardType",
  "NSFilenamesPboardType",
  "NeXT TIFF v4.0 pasteboard type",
  "NeXT Rich Text Format v1.0 pasteboard type",
  "NeXT RTFD pasteboard type",
  "Apple PNG pasteboard type",
  "Apple PDF pasteboard type",
  "Apple HTML pasteboard type",
  "Apple URL pasteboard type",
  "Apple Web Archive pasteboard type",
  "CorePasteboardFlavorType 0x75743136",
  "CorePasteboardFlavorType 0x75747874",
  "CorePasteboardFlavorType 0x6675726C",
  "CorePasteboardFlavorType 0x75726C20",
  "CorePasteboardFlavorType 0x75726C6E",
  "CorePasteboardFlavorType 0x4A504547",
  "CorePasteboardFlavorType 0x54455854",
  "text/plain",
  "text/html",
  "text/uri-list",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/rtf",
]);
const UNRECOGNISED_TYPE = "other";
const CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_.]{0,79}$/;
const DYNAMIC_TYPE = /^dyn\./;
const MAX_TYPES = 24;
const MAX_DROPPED = 1000;
const MAX_TYPE_COUNT = 1000;

function identifier(value: unknown, pattern = IDENTIFIER): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function typeName(type: unknown): string | null {
  if (typeof type !== "string") return null;
  if (DYNAMIC_TYPE.test(type)) return "dyn";
  return STANDARD_TYPES.has(type) ? type : UNRECOGNISED_TYPE;
}

function typeIds(types: unknown): string | null {
  if (!Array.isArray(types)) return null;
  const names = types.flatMap((type) => {
    const name = typeName(type);
    return name ? [name] : [];
  });
  return [...new Set(names)].slice(0, MAX_TYPES).join(",");
}

export function watchPasteRefused() {
  onAppEvent((e) => {
    if (e.type === "pasteRefused") capturePasteRefused(e);
  });
}

function capturePasteRefused(e: PasteRefusedEvent) {
  const ids = typeIds(e.types);
  const layout = identifier(e.layout);
  const responder = identifier(e.responder, CLASS_NAME);
  const raw: Record<string, unknown> = {};
  if (ids !== null) raw.type_ids = ids;
  if (Array.isArray(e.types)) raw.type_count = Math.min(e.types.length, MAX_TYPE_COUNT);
  if (layout) raw.keyboard_layout = layout;
  if (responder) raw.responder = responder;
  capture(
    "paste_refused",
    {
      reason: REASONS.has(e.reason) ? e.reason : "unknown",
      gate_open: e.gateOpen === true,
      ...(Number.isSafeInteger(e.dropped) && e.dropped! >= 0 ? { dropped: Math.min(e.dropped!, MAX_DROPPED) } : {}),
    },
    { raw },
  );
}
