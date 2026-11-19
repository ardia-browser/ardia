import { nativeModule } from "./nativeModules";

export type TranslatedBlocks = { parts: (string[] | null)[]; errors: string[] };

export type TranslationModule = {
  readonly available: boolean;
  userLanguages(): string[];
  languageName(identifier: string): string;
  detect(text: string): Promise<string | null>;
  status(source: string, target: string): Promise<"installed" | "supported" | "unsupported">;
  supportedLanguages(): Promise<string[]>;
  prepare(source: string, target: string): Promise<void>;
  translate(source: string, target: string, texts: string[]): Promise<(string | null)[]>;
  translateBlocks(source: string, target: string, blocks: string[][], owner: string): Promise<(string[] | null)[] | TranslatedBlocks>;
  open(owner: string): Promise<void>;
  cancel(owner: string): Promise<void>;
};
const TranslationNative = nativeModule("ArdiaTranslate");

export const translation: Omit<TranslationModule, "available"> | null = TranslationNative.available ? TranslationNative : null;
