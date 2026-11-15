import { app } from "electron";
import { defineModule, emit } from "../bridge";
import { count } from "../counts";
import { note } from "../log";
import { detectLanguage } from "../translate/detect";
import { cancelOwner, openOwner, translatePassages, translateTexts } from "../translate/engine";
import { ensurePairs, installed, languages, PIVOT, route } from "../translate/models";

const PROGRESS_EVERY_MS = 200;

const names = new Intl.DisplayNames(["en"], { type: "language" });

function languageName(identifier: string): string {
  try {
    return names.of(identifier) ?? identifier;
  } catch {
    return identifier;
  }
}

function userLanguages(): string[] {
  const preferred = app.getPreferredSystemLanguages().filter((language) => language && !/^(c|posix)$/i.test(language));
  return preferred.length ? preferred : [app.getLocale() || "en-US"];
}

async function prepare(source: string, target: string) {
  const pairs = route(source, target);
  if (!pairs) throw new Error(`${languageName(source)} to ${languageName(target)} isn't available`);
  const present = await Promise.all(pairs.map(installed));
  const fetched = [...new Set(pairs.filter((_, i) => !present[i]).flatMap((pair) => pair.split(">")).filter((language) => language !== PIVOT))];
  let shownAt = 0;
  try {
    const downloaded = await ensurePairs(pairs, ({ received, total }) => {
      const now = Date.now();
      if (received < total && now - shownAt < PROGRESS_EVERY_MS) return;
      shownAt = now;
      emit("ArdiaTranslate", "onDownload", { source, target, languages: fetched, received, total });
    });
    if (downloaded) count("translate_model_downloads");
  } catch (error) {
    count("translate_model_download_failures");
    const reason = error instanceof Error ? error.message : String(error);
    note("translate", `downloading ${pairs.join(", ")} failed: ${reason}`);
    throw new Error(`couldn't download the ${languageName(source)} language files: ${reason}`);
  }
}

defineModule("ArdiaTranslate", {
  constants: { available: true },
  sync: { userLanguages, languageName },
  async: {
    detect: (text: string) => (typeof text === "string" ? detectLanguage(text).catch(() => null) : Promise.resolve(null)),
    async status(source: string, target: string) {
      const pairs = route(source, target);
      if (!pairs) return "unsupported";
      return (await Promise.all(pairs.map(installed))).every(Boolean) ? "installed" : "supported";
    },
    supportedLanguages: async () => languages(),
    prepare,
    translate: (source: string, target: string, texts: string[]) => translateTexts(source, target, texts),
    async translateBlocks(source: string, target: string, blocks: string[][], owner: string) {
      try {
        return await translatePassages(source, target, blocks, owner);
      } catch (error) {
        count("translate_engine_failures");
        throw error;
      }
    },
    open: async (owner: string) => openOwner(owner),
    cancel: async (owner: string) => cancelOwner(owner),
  },
});
