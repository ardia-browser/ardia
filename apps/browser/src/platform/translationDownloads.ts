export type TranslationDownload = { source: string; target: string; languages: string[]; received: number; total: number };

export const onTranslationDownload = (_listener: (download: TranslationDownload) => void): { remove(): void } => ({ remove() {} });
