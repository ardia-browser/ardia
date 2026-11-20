import type { LibraryEntry, LibraryExit } from "./library";

export type LibraryPagerDriver = (windowId: string, open: boolean, cause: LibraryEntry | LibraryExit) => boolean;

let driver: LibraryPagerDriver | null = null;

export function setLibraryPagerDriver(next: LibraryPagerDriver | null): () => void {
  driver = next;
  return () => {
    if (driver === next) driver = null;
  };
}

export const driveLibraryPager = (windowId: string, open: boolean, cause: LibraryEntry | LibraryExit): boolean => driver?.(windowId, open, cause) ?? false;

export type LibraryHeading = { open: boolean; cause: LibraryEntry | LibraryExit };

export type LibraryPagerIntent = (windowId: string) => LibraryHeading | undefined;

let intent: LibraryPagerIntent | null = null;

export function setLibraryPagerIntent(next: LibraryPagerIntent | null): () => void {
  intent = next;
  return () => {
    if (intent === next) intent = null;
  };
}

export const libraryPagerIntent = (windowId: string): LibraryHeading | undefined => intent?.(windowId);
