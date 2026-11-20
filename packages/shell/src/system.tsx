import { requireNativeViewManager, type EventSubscription } from "expo-modules-core";
import { forwardRef, type Ref } from "react";
import type { View, ViewProps } from "react-native";
import { nativeModule } from "./nativeModules";

export type MenuShortcut = { id: string; title: string; path: string[] } & (
  | { remappable: true }
  | { remappable: false; key: string; modifiers: ShortcutModifier[] }
);

export type ShortcutModifier = "control" | "option" | "shift" | "command" | "function";

export type FolderMediaKind = "image" | "video" | "audio";
export type FolderMediaFile = { path: string; name: string; size: number; added: number; modified: number; kind: FolderMediaKind };
export type FolderMediaStatus = "ok" | "missing" | "denied" | "unavailable";
export type FolderMediaListing = { status: FolderMediaStatus; files: FolderMediaFile[] };

type LaunchAtLoginStatus = "enabled" | "requiresApproval" | "notRegistered" | "notFound";

export type SystemNative = {
  backgroundInstance?: boolean;
  isDefaultBrowser(): Promise<boolean>;
  setAsDefaultBrowser(): Promise<boolean>;
  launchAtLoginStatus(): Promise<LaunchAtLoginStatus>;
  setLaunchAtLogin(enabled: boolean): Promise<void>;
  fileExists(path: string): boolean;
  openFile(path: string): Promise<boolean>;
  revealFile(path: string): Promise<boolean>;
  moveToTrash(path: string): Promise<boolean>;
  fileIcon(path: string, size: number): Promise<string | null>;
  fileThumbnail(path: string, size: number, ephemeral?: boolean): Promise<string | null>;
  forgetThumbnails?(paths: string[] | null): Promise<void>;
  imageSize?(path: string): Promise<{ width: number; height: number } | null>;
  runningAppIcon(pid: number, size: number): Promise<string | null>;
  listFolderMedia(folder: string, limit: number): Promise<FolderMediaListing | FolderMediaFile[]>;
  watchFolder(token: string, folder: string): void;
  unwatchFolder(token: string): void;
  addListener(name: "onFolderChange", listener: (event: { token: string }) => void): EventSubscription;
  hapticTick(): void;
  setThinScrollBars(thin: boolean): Promise<void>;
};

const System = nativeModule("ArdiaSystem");

export const backgroundInstance = System.backgroundInstance === true;
export const isDefaultBrowser = () => System.isDefaultBrowser();
export const setAsDefaultBrowser = () => System.setAsDefaultBrowser();
export const launchAtLoginStatus = () => System.launchAtLoginStatus();
export const setLaunchAtLogin = (enabled: boolean) => System.setLaunchAtLogin(enabled);

export const fileExists = (path: string) => System.fileExists(path);
export const openFile = (path: string) => System.openFile(path);
export const revealFile = (path: string) => System.revealFile(path);
export const moveToTrash = (path: string) => System.moveToTrash(path);
export const fileIcon = (path: string, size = 32) => System.fileIcon(path, size);
export const fileThumbnail = (path: string, size: number, ephemeral = false) => System.fileThumbnail(path, size, ephemeral);
export const forgetThumbnails = async (paths?: readonly string[]): Promise<void> => {
  if (typeof System.forgetThumbnails === "function") await System.forgetThumbnails(paths ? [...paths] : null);
};
export const imageSize = async (path: string): Promise<{ width: number; height: number } | null> =>
  typeof System.imageSize === "function" ? System.imageSize(path) : null;
export const runningAppIcon = (pid: number, size = 32) => System.runningAppIcon(pid, size);
const FOLDER_STATUSES: ReadonlySet<string> = new Set<FolderMediaStatus>(["ok", "missing", "denied", "unavailable"]);

export function folderMediaListing(reply: unknown): FolderMediaListing {
  if (Array.isArray(reply)) return { status: "ok", files: reply };
  if (!reply || typeof reply !== "object") return { status: "unavailable", files: [] };
  const { status, files } = reply as { status?: unknown; files?: unknown };
  if (typeof status !== "string" || !FOLDER_STATUSES.has(status)) return { status: "unavailable", files: [] };
  return { status: status as FolderMediaStatus, files: status === "ok" && Array.isArray(files) ? files : [] };
}

export const listFolderMedia = async (folder: string, limit: number): Promise<FolderMediaListing> => folderMediaListing(await System.listFolderMedia(folder, limit));

let folderWatches = 0;

export function watchFolder(folder: string, onChange: () => void): () => void {
  const token = `folder-${++folderWatches}`;
  const subscription = System.addListener("onFolderChange", (event) => event.token === token && onChange());
  System.watchFolder(token, folder);
  return () => {
    subscription.remove();
    System.unwatchFolder(token);
  };
}

export const hapticTick = () => System.hapticTick();
export const setThinScrollBars = (thin: boolean) => System.setThinScrollBars(thin);

export type MiddleClickEvent = { shiftKey: boolean; altKey: boolean; metaKey: boolean };

export type MouseAreaProps = ViewProps & {
  path?: string | null;
  onMiddleClick?: (e: MiddleClickEvent) => void;
};

export type NativeMouseAreaProps = Omit<MouseAreaProps, "onMiddleClick"> & { onMiddleClick?: (e: { nativeEvent: MiddleClickEvent }) => void };

const NativeMouseArea = requireNativeViewManager<NativeMouseAreaProps>("ArdiaFileDrag");

export function MouseArea({ path, onMiddleClick, ...props }: MouseAreaProps) {
  return <NativeMouseArea path={path} onMiddleClick={onMiddleClick && ((e) => onMiddleClick(e.nativeEvent))} {...props} />;
}

export type DroppedItem = { kind: "file"; url: string } | { kind: "url"; url: string } | { kind: "text"; text: string };
export type DropUpdate = { phase: "enter" | "move" | "exit" | "drop"; x: number; y: number; count: number; items: DroppedItem[] };
export type FileDropAreaProps = ViewProps & {
  accepts?: "links" | "linksAndText" | "extensionPackages";
  enabled?: boolean;
  onDropUpdate?: (e: DropUpdate) => void;
};

export type FileDropHandle = { nativeRef?: { current: View | null } };

export type NativeFileDropAreaProps = Omit<FileDropAreaProps, "onDropUpdate"> & {
  ref?: (instance: FileDropHandle | null) => void;
  onDropUpdate?: (e: { nativeEvent: DropUpdate }) => void;
};

const NativeFileDropArea = requireNativeViewManager<NativeFileDropAreaProps>("ArdiaFileDrop");

export type MagnifyPhase = "began" | "changed" | "ended" | "cancelled";
export type MagnifyUpdate = { phase: MagnifyPhase; magnification: number };
export type MagnifyAreaProps = ViewProps & {
  enabled?: boolean;
  onMagnify?: (e: MagnifyUpdate) => void;
};

export type NativeMagnifyAreaProps = Omit<MagnifyAreaProps, "onMagnify"> & { onMagnify?: (e: { nativeEvent: MagnifyUpdate }) => void };

const NativeMagnifyArea = requireNativeViewManager<NativeMagnifyAreaProps>("ArdiaMagnifyArea");
export type MagnifyAreaNative = {
  devMagnify(windowId: string, x: number, y: number, steps: MagnifyUpdate[]): Promise<{ claimed?: boolean[]; hit?: string; error?: string }>;
};

const MagnifyModule = nativeModule("ArdiaMagnifyArea");

export function MagnifyArea({ onMagnify, enabled = true, ...props }: MagnifyAreaProps) {
  return <NativeMagnifyArea enabled={enabled} onMagnify={onMagnify && ((e) => onMagnify(e.nativeEvent))} {...props} />;
}

export const devMagnify = (windowId: string, at: { x: number; y: number }, steps: MagnifyUpdate[]) =>
  MagnifyModule.devMagnify(windowId, at.x, at.y, steps);

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

export const FileDropArea = forwardRef<View, FileDropAreaProps>(function FileDropArea({ onDropUpdate, ...props }, ref) {
  return (
    <NativeFileDropArea
      ref={(instance) => assignRef(ref, instance?.nativeRef?.current ?? null)}
      onDropUpdate={onDropUpdate && ((e) => onDropUpdate(e.nativeEvent))}
      {...props}
    />
  );
});

export type DevDragAction = "move" | "drop" | "cancel" | "end";
export type DevDragPayload = { files?: string[]; urls?: string[]; publicURLs?: string[]; text?: string; fileDrag?: boolean };

export type FileDropNative = {
  devDrag(windowId: string, action: DevDragAction, x: number, y: number, payload: DevDragPayload | null): Promise<string>;
  devLastFileDrag(): Promise<string[]>;
};

const FileDrop = nativeModule("ArdiaFileDrop");

export const devFileDrag = {
  drag: (windowId: string, action: DevDragAction, x: number, y: number, payload?: DevDragPayload) =>
    FileDrop.devDrag(windowId, action, x, y, payload ?? null),
  lastFileDrag: () => FileDrop.devLastFileDrag(),
};
