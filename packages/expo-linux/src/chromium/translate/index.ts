import { cancelOwner, openOwner, translatePassages, translateTexts, useTranslationHost } from "./engine";
import type { BrowserModelFiles } from "./worker";
import { callMain } from "../../bridge";

const TRANSLATE = "ArdiaTranslate";

const names = new Intl.DisplayNames(["en"], { type: "language" });

function languageName(identifier: string): string {
  try {
    return names.of(identifier) ?? identifier;
  } catch {
    return identifier;
  }
}

useTranslationHost({
  modelFiles: async (source, target) => (await callMain<{ key: string; files: BrowserModelFiles }[] | null>(TRANSLATE, "modelFiles", source, target)) ?? null,
  count: (name) => void callMain(TRANSLATE, "count", name).catch(() => undefined),
  note: (message) => void callMain(TRANSLATE, "note", message).catch(() => undefined),
});

export const translateModules: Record<string, Record<string, unknown>> = {
  ArdiaTranslate: {
    languageName,
    translate: (source: string, target: string, texts: string[]) => translateTexts(source, target, texts),
    async translateBlocks(source: string, target: string, blocks: string[][], owner: string) {
      try {
        return await translatePassages(source, target, blocks, owner);
      } catch (error) {
        void callMain(TRANSLATE, "count", "translate_engine_failures").catch(() => undefined);
        throw error;
      }
    },
    open: async (owner: string) => openOwner(owner),
    cancel: async (owner: string) => cancelOwner(owner),
  },
};
