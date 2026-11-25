import type { ImportEvent, ImportKind, NativeImportOptions } from "../index";

export type ImportNative = {
  listBrowsers(): Promise<string>;
  importData(jobId: string, browserId: string, profileId: string, kinds: ImportKind[], options: NativeImportOptions): Promise<string>;
  cancelImport(jobId: string): void | Promise<void>;
  unlockBrowser(browserId: string, primaryPassword: string | null): Promise<null>;
  isBrowserUnlocked(browserId: string): boolean;
  forgetUnlockedKeys(): void | Promise<void>;
  writeImported(token: string, profile: string, kinds: ("cookies" | "autofill")[]): Promise<string>;
  discardImported(token: string): void | Promise<void>;
  listExtensions(browserId: string, profileId: string): Promise<string>;
  importSafariExport(jobId: string, path: string): Promise<string>;
  safariHasFullDiskAccess(): boolean;
  openFullDiskAccessSettings(): Promise<null>;
  importSafariDirect(jobId: string): Promise<string>;
  readDiaTabs(): Promise<string>;
  importBookmarksHTML(path: string): Promise<string>;
  importPasswordsCSV(path: string): Promise<string>;
  chooseImportFile(kind: "safariExport" | "bookmarksHTML" | "passwordsCSV"): Promise<string | null>;
  addListener(name: "onImportEvent", listener: (event: ImportNativeEvents["onImportEvent"]) => void): { remove(): void };
};

export type ImportNativeEvents = {
  onImportEvent: ImportEvent;
};

export type ImportModules = {
  ArdiaImport: ImportNative;
};
