import { forwardRef, type ComponentProps, type ElementRef } from "react";
import { Image as WebImage } from "react-native-web";
import { callMainSync } from "../bridge";

const FILE = "file://";
const SERVED_REPORTS = "/reports/";
const SERVED_IMPORT_IMAGES = "/import-images";

let reportsFolder: string | null | undefined;
const importImages = new Set<string>();

export function serveImportImages(paths: Iterable<string>): void {
  for (const path of paths) importImages.add(path);
}

function reportsRoot(): string | null {
  if (reportsFolder !== undefined) return reportsFolder;
  const draft = callMainSync<string>("ArdiaReport", "draftDirectory");
  const cut = typeof draft === "string" ? draft.lastIndexOf("/") : -1;
  reportsFolder = cut > 0 ? draft!.slice(0, cut + 1) : null;
  return reportsFolder;
}

export function servedUri(uri: string): string {
  if (!uri.startsWith(FILE)) return uri;
  const path = uri.slice(FILE.length);
  if (importImages.has(path)) return `${location.origin}${SERVED_IMPORT_IMAGES}${path.split("/").map(encodeURIComponent).join("/")}`;
  const root = reportsRoot();
  if (!root || !path.startsWith(root) || path.includes("/../")) return uri;
  return `${location.origin}${SERVED_REPORTS}${path.slice(root.length)}`;
}

type Props = ComponentProps<typeof WebImage>;

function servedSource(source: Props["source"]): Props["source"] {
  if (!source || typeof source !== "object" || Array.isArray(source)) return source;
  const uri = (source as { uri?: unknown }).uri;
  return typeof uri === "string" && uri.startsWith(FILE) ? { ...source, uri: servedUri(uri) } : source;
}

const ServedImage = forwardRef<ElementRef<typeof WebImage>, Props>(function ServedImage(props, ref) {
  return <WebImage {...props} source={servedSource(props.source)} ref={ref} />;
});

const statics = WebImage as unknown as Record<string, unknown>;

export const Image = Object.assign(ServedImage, {
  getSize: statics.getSize,
  getSizeWithHeaders: statics.getSizeWithHeaders,
  prefetch: statics.prefetch,
  queryCache: statics.queryCache,
  resolveAssetSource: statics.resolveAssetSource,
}) as unknown as typeof WebImage;
