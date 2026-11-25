import { nativeModule } from "./nativeModules";
import type { TranslateNative } from "./generated/native";

export type TranslationModule = TranslateNative;
const TranslationNative = nativeModule("ArdiaTranslate");

export const translation: Omit<TranslationModule, "available"> | null = TranslationNative.available ? TranslationNative : null;
