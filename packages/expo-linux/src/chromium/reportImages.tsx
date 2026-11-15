import { forwardRef, type ComponentProps, type ElementRef } from "react";
import { Image as WebImage } from "react-native-web";
import { callMainSync } from "../bridge";

const FILE = "file://";
const SERVED = "/reports/";

let reportsFolder: string | null | undefined;

function reportsRoot(): string | null {
  if (reportsFolder !== undefined) return reportsFolder;
  const draft = callMainSync<string>("ArdiaReport", "draftDirectory");
  const cut = typeof draft === "string" ? draft.lastIndexOf("/") : -1;
  reportsFolder = cut > 0 ? draft!.slice(0, cut + 1) : null;
  return reportsFolder;
}

export function servedReportUri(uri: string): string {
  if (!uri.startsWith(FILE)) return uri;
  const root = reportsRoot();
  const path = uri.slice(FILE.length);
  if (!root || !path.startsWith(root) || path.includes("/../")) return uri;
  return `${location.origin}${SERVED}${path.slice(root.length)}`;
}

type Props = ComponentProps<typeof WebImage>;

function servedSource(source: Props["source"]): Props["source"] {
  if (!source || typeof source !== "object" || Array.isArray(source)) return source;
  const uri = (source as { uri?: unknown }).uri;
  return typeof uri === "string" && uri.startsWith(FILE) ? { ...source, uri: servedReportUri(uri) } : source;
}

const ReportServedImage = forwardRef<ElementRef<typeof WebImage>, Props>(function ReportServedImage(props, ref) {
  return <WebImage {...props} source={servedSource(props.source)} ref={ref} />;
});

const statics = WebImage as unknown as Record<string, unknown>;

export const Image = Object.assign(ReportServedImage, {
  getSize: statics.getSize,
  getSizeWithHeaders: statics.getSizeWithHeaders,
  prefetch: statics.prefetch,
  queryCache: statics.queryCache,
  resolveAssetSource: statics.resolveAssetSource,
}) as unknown as typeof WebImage;
