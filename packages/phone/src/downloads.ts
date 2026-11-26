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
  handOffAppUpdate?(url: string, title: string): Promise<unknown>;
  appUpdateStatus?(id: string): Promise<unknown>;
  appUpdateProgress?(id: string): Promise<unknown>;
  verifyAppUpdate?(id: string, sha256: string, fileName: string): Promise<unknown>;
  installVerifiedUpdate?(fileName: string, sha256: string, downloadId: string): Promise<unknown>;
  updateNotificationsShown?(): boolean;
  takeInstallRequest?(): unknown;
  takeInstallStatus?(): unknown;
  notifyUpdateReady?(fileName: string, title: string, text: string): Promise<boolean>;
  askForUpdateNotifications?(): Promise<void>;
  discardAppUpdate?(id: string): Promise<boolean>;
  canInstallPackages?(): boolean;
  openInstallPermission?(): Promise<boolean>;
  installDownloadedFile?(uri: string): Promise<unknown>;
  addListener(eventName: "onAppUpdateDownloaded", listener: (event: { id: string }) => void): Subscription;
  addListener(eventName: "onAppUpdateInstallStatus", listener: (event: unknown) => void): Subscription;
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
  handsOffAppUpdates: (): boolean => typeof native().handOffAppUpdate === "function",
  handOffAppUpdate: (url: string, title: string): Promise<unknown> => native().handOffAppUpdate?.(url, title) ?? Promise.resolve({ handoff: "unavailable" }),
  appUpdateStatus: (id: string): Promise<unknown> => native().appUpdateStatus?.(id) ?? Promise.resolve("gone"),
  appUpdateProgress: (id: string): Promise<unknown> => native().appUpdateProgress?.(id) ?? Promise.resolve(-1),
  verifyAppUpdate: (id: string, sha256: string, fileName: string): Promise<unknown> => native().verifyAppUpdate?.(id, sha256, fileName) ?? Promise.resolve("failed"),
  installVerifiedUpdate: (fileName: string, sha256: string, downloadId: string): Promise<unknown> => native().installVerifiedUpdate?.(fileName, sha256, downloadId) ?? Promise.resolve({ result: "failed" }),
  updateNotificationsShown: (): boolean => native().updateNotificationsShown?.() ?? false,
  takeInstallRequest: (): boolean => native().takeInstallRequest?.() === true,
  takeInstallStatus: (): unknown => native().takeInstallStatus?.() ?? null,
  addInstallStatusListener: (listener: (event: unknown) => void): Subscription => native().addListener("onAppUpdateInstallStatus", listener),
  notifyUpdateReady: (fileName: string, title: string, text: string): Promise<boolean> => native().notifyUpdateReady?.(fileName, title, text) ?? Promise.resolve(false),
  askForUpdateNotifications: (): Promise<void> => native().askForUpdateNotifications?.() ?? Promise.resolve(),
  discardAppUpdate: (id: string): Promise<boolean> => native().discardAppUpdate?.(id) ?? Promise.resolve(false),
  canInstallPackages: (): boolean => native().canInstallPackages?.() ?? false,
  openInstallPermission: (): Promise<boolean> => native().openInstallPermission?.() ?? Promise.resolve(false),
  installsPackages: (): boolean => typeof native().installDownloadedFile === "function",
  installDownloadedFile: (uri: string): Promise<unknown> => native().installDownloadedFile?.(uri) ?? Promise.resolve({ result: "failed" }),
  addAppUpdateListener: (listener: (event: { id: string }) => void): Subscription => native().addListener("onAppUpdateDownloaded", listener),
  addListener: (listener: (event: DownloadEvent) => void): Subscription => native().addListener("onDownloadEvent", listener),
};
