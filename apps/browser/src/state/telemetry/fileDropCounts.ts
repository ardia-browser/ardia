import { onAppEvent } from "../../platform/app";
import { capture, counted } from "./client";
import { nativeConsent } from "./nativeConsent";

const FIELDS = {
  links: "file_drops_refused_links",
  linksAndText: "file_drops_refused_links_and_text",
  extensionPackages: "file_drops_refused_extension_packages",
} as const;

type Area = keyof typeof FIELDS;

const counts: Record<Area, number> = { links: 0, linksAndText: 0, extensionPackages: 0 };
let unknownArea = 0;

const kindOf = (area: unknown): Area | null => (typeof area === "string" && Object.hasOwn(FIELDS, area) ? (area as Area) : null);

onAppEvent((e) => {
  if (e.type !== "fileDropRefused") return;
  const area = kindOf(e.area);
  counted(
    nativeConsent(e),
    () => void (area ? counts[area]++ : unknownArea++),
    () => capture("usage_counts", { [area ? FIELDS[area] : "file_drops_refused_other"]: 1 }, null),
  );
});

export function takeFileDropCounts() {
  const taken = {
    file_drops_refused_links: counts.links,
    file_drops_refused_links_and_text: counts.linksAndText,
    file_drops_refused_extension_packages: counts.extensionPackages,
    file_drops_refused_other: unknownArea,
  };
  counts.links = counts.linksAndText = counts.extensionPackages = unknownArea = 0;
  return taken;
}
