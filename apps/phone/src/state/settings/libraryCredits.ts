import credits from "./credits.json";
import { t } from "../../lib/uiLanguage";


export type LibraryCredit = { name: string; detail: string; license: string; url: string };

export const IPHONE_NATIVE_CREDITS: LibraryCredit[] = [
  {
    name: t(`ArdiaKit and ArdiaSyncCore`),
    detail: t(`Ardia’s own iPhone code: ArdiaShared, ArdiaSync, ArdiaBrowser, ArdiaDesign, ArdiaTalk, ArdiaSyncCore`),
    license: "Apache-2.0",
    url: "https://github.com/mantrakp04/ardia",
  },
  {
    name: t(`ptts (PhononTTS)`),
    detail: t(`0.7.1, Gradium’s on-device speech for Talk to Me`),
    license: t(`MIT or Apache-2.0`),
    url: "https://github.com/gradium-ai/xn-ptts",
  },
  {
    name: t(`Phonon 31M`),
    detail: t(`Gradium’s English voice model and voices, downloaded when Talk to Me is turned on`),
    license: "Apache-2.0",
    url: "https://huggingface.co/gradium/phonon-31m-en",
  },
];

const androidNative = (): LibraryCredit[] => credits.native.map((library) => ({ name: library.name, detail: library.artifacts.join(", "), license: library.license, url: library.url }));

export function libraryCredits(platform: "ios" | "android" | string): LibraryCredit[] {
  const native = platform === "ios" ? IPHONE_NATIVE_CREDITS : androidNative();
  return [...native, ...credits.packages.map((pkg) => ({ name: pkg.name, detail: pkg.version, license: pkg.license, url: pkg.url }))];
}
