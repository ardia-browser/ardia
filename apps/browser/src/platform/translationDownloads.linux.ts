import { requireNativeModule } from "expo-modules-core";
import type { TranslationDownload } from "./translationDownloads";

export type { TranslationDownload } from "./translationDownloads";

type TranslationDownloadsNative = { addListener(name: "onDownload", listener: (download: TranslationDownload) => void): { remove(): void } };

export const onTranslationDownload = (listener: (download: TranslationDownload) => void) => requireNativeModule<TranslationDownloadsNative>("ArdiaTranslate").addListener("onDownload", listener);
