export class ImportError extends Error {}

export class ImportCancelled extends Error {
  constructor() {
    super("The import was cancelled.");
  }
}

export const IMPORT_LIMITS = {
  textBytes: 16 * 1024 * 1024,
  jsonBytes: 96 * 1024 * 1024,
  attachmentBytes: 64 * 1024 * 1024,
  spoolBytes: 2 * 1024 * 1024 * 1024,
  files: 100_000,
  pages: 20_000,
  blocksPerPage: 20_000,
  depth: 24,
  nestedZips: 64,
  rows: 10_000,
  columns: 200,
};
