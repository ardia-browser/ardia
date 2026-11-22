import { requireNativeModule } from "expo-modules-core";
import type { DownloadEvent, DownloadProgress, Subscription } from "./pageTypes";

export type DownloadedFileKind = "image" | "video" | "audio" | "pdf" | "archive" | "document";

export type DownloadedFile = { name: string; uri: string; size: number; modified: number; kind: DownloadedFileKind };

type DownloadsNative = {
  addListener(eventName: "onDownloadEvent", listener: (event: DownloadEvent) => void): Subscription;
  active(): Promise<DownloadProgress[]>;
  cancel(id: string): Promise<void>;
  open(uri: string): Promise<boolean>;
  files?(): Promise<DownloadedFile[]>;
  delete?(uri: string): Promise<boolean>;
  deleteAll?(): Promise<number>;
  preview?(uri: string): Promise<boolean>;
  share?(uri: string): Promise<boolean>;
};

let loaded: DownloadsNative | undefined;
const native = () => (loaded ??= requireNativeModule<DownloadsNative>("ArdiaPhoneDownloads"));

export const downloads = {
  active: () => native().active(),
  cancel: (id: string) => native().cancel(id),
  open: (uri: string) => native().open(uri),
  listsFiles: (): boolean => typeof native().files === "function",
  files: (): Promise<DownloadedFile[]> => native().files?.() ?? Promise.resolve([]),
  delete: (uri: string): Promise<boolean> => native().delete?.(uri) ?? Promise.resolve(false),
  deleteAll: (): Promise<number> => native().deleteAll?.() ?? Promise.resolve(0),
  preview: (uri: string): Promise<boolean> => native().preview?.(uri) ?? Promise.resolve(false),
  share: (uri: string): Promise<boolean> => native().share?.(uri) ?? native().open(uri),
  addListener: (listener: (event: DownloadEvent) => void): Subscription => native().addListener("onDownloadEvent", listener),
};
