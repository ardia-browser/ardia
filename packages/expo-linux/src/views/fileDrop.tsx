import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { View } from "react-native";
import type { DropUpdate, DroppedItem, FileDropAreaProps, FileDropHandle, NativeFileDropAreaProps } from "@ardia/shell";
import { bridge, callMainSync } from "../bridge";

type Accepts = NonNullable<FileDropAreaProps["accepts"]>;
type Phase = DropUpdate["phase"];

const MAX_ITEMS = 50;
const MAX_SEARCH_TEXT = 2048;
const EXTENSION_PACKAGE = "application/x-chrome-extension";

const claimed = new WeakSet<Event>();

export function webUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.length >= 8192) return null;
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

export function hostLike(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.length >= 2048 || /\s/.test(text)) return null;
  const colon = text.indexOf(":");
  if (colon > 0) {
    const scheme = text.slice(0, colon);
    if (/^[\p{L}\p{N}+.-]+$/u.test(scheme) && !scheme.includes(".")) return webUrl(text);
  }
  return text.includes(".") ? text : null;
}

export function droppedLinks(uriList: string, text: string, anyText: boolean): DroppedItem[] {
  const links = uriList
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map(webUrl)
    .filter((url): url is string => !!url);
  if (links.length) return links.slice(0, MAX_ITEMS).map((url) => ({ kind: "url", url }));
  if (!text) return [];
  const candidate = hostLike(text);
  if (candidate) {
    const url = webUrl(candidate);
    return [url ? { kind: "url", url } : { kind: "text", text: candidate }];
  }
  const words = text.split(/\s+/).filter(Boolean).join(" ");
  return anyText && words ? [{ kind: "text", text: words.slice(0, MAX_SEARCH_TEXT) }] : [];
}

function fileItems(transfer: DataTransfer): DataTransferItem[] {
  return [...transfer.items].filter((item) => item.kind === "file");
}

function countOf(transfer: DataTransfer, accepts: Accepts): number {
  const files = fileItems(transfer);
  if (accepts === "extensionPackages") return files.length && files.length <= MAX_ITEMS && files.every((item) => item.type === EXTENSION_PACKAGE) ? files.length : 0;
  if (files.length) return Math.min(files.length, MAX_ITEMS);
  const types = [...transfer.types];
  if (types.includes("text/uri-list")) return 1;
  return types.includes("text/plain") ? 1 : 0;
}

function itemsOf(transfer: DataTransfer, accepts: Accepts): DroppedItem[] {
  const files = [...transfer.files];
  if (files.length) {
    const linux = bridge();
    const paths = files.map((file) => linux?.pathForFile?.(file) ?? "").filter(Boolean);
    return callMainSync<DroppedItem[]>("ArdiaLinuxFileDrop", "droppedFiles", paths, accepts) ?? [];
  }
  if (accepts === "extensionPackages") return [];
  return droppedLinks(transfer.getData("text/uri-list"), transfer.getData("text/plain"), accepts === "linksAndText");
}

export const FileDrop = forwardRef<FileDropHandle, NativeFileDropAreaProps>(function FileDrop({ accepts, enabled, onDropUpdate, ...props }, ref) {
  const nativeRef = useRef<View | null>(null);
  useImperativeHandle(ref, () => ({ nativeRef }), []);
  const latest = useRef({ accepts: accepts ?? "links", enabled: enabled !== false, onDropUpdate });
  latest.current = { accepts: accepts ?? "links", enabled: enabled !== false, onDropUpdate };

  useEffect(() => {
    const element = nativeRef.current as unknown as HTMLElement | null;
    if (!element) return;
    let count = 0;
    const emit = (phase: Phase, event: DragEvent | null, items: DroppedItem[] = []) => {
      const rect = element.getBoundingClientRect();
      const x = event ? event.clientX - rect.left : 0;
      const y = event ? event.clientY - rect.top : 0;
      latest.current.onDropUpdate?.({ nativeEvent: { phase, x, y, count, items } });
    };
    const over = (event: DragEvent) => {
      const transfer = event.dataTransfer;
      if (claimed.has(event)) {
        if (count > 0) {
          emit("exit", event);
          count = 0;
        }
        return;
      }
      if (!transfer || !latest.current.enabled) return;
      if (count === 0) {
        count = countOf(transfer, latest.current.accepts);
        if (count === 0) return;
        emit("enter", event);
      } else emit("move", event);
      claimed.add(event);
      event.preventDefault();
      transfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (count === 0) return;
      const into = event.relatedTarget as Node | null;
      if (into && element.contains(into)) return;
      emit("exit", event);
      count = 0;
    };
    const drop = (event: DragEvent) => {
      if (count === 0 || claimed.has(event)) return;
      claimed.add(event);
      event.preventDefault();
      const transfer = event.dataTransfer;
      const items = transfer && latest.current.enabled ? itemsOf(transfer, latest.current.accepts) : [];
      emit("drop", event, items);
      count = 0;
    };
    element.addEventListener("dragenter", over);
    element.addEventListener("dragover", over);
    element.addEventListener("dragleave", leave);
    element.addEventListener("drop", drop);
    return () => {
      element.removeEventListener("dragenter", over);
      element.removeEventListener("dragover", over);
      element.removeEventListener("dragleave", leave);
      element.removeEventListener("drop", drop);
      if (count > 0) latest.current.onDropUpdate?.({ nativeEvent: { phase: "exit", x: 0, y: 0, count, items: [] } });
    };
  }, []);

  return <View {...props} ref={nativeRef} />;
});
