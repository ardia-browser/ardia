import type { FolderMediaListing } from "@ardia/shell";

export { fileExists, openFile, revealFile, moveToTrash, fileIcon, runningAppIcon } from "@ardia/shell";
export type { FolderMediaFile, FolderMediaKind, FolderMediaListing, FolderMediaStatus } from "@ardia/shell";

export const fileThumbnail = async (_path: string, _size: number, _ephemeral = false): Promise<string | null> => null;

export const forgetThumbnails = async (_paths?: readonly string[]): Promise<void> => {};

export const imageSize = async (_path: string): Promise<{ width: number; height: number } | null> => null;

export const listFolderMedia = async (_folder: string, _limit: number): Promise<FolderMediaListing> => ({ status: "ok", files: [] });

export const watchFolder = (_folder: string, _onChange: () => void): (() => void) => () => {};
