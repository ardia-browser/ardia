import credits from "./credits.json";

export type LibraryCredit = { name: string; detail: string; license: string; url: string };

export const IPHONE_NATIVE_CREDITS: LibraryCredit[] = [
  {
    name: "ArdiaKit and ArdiaSyncCore",
    detail: "Ardia’s own iPhone code: ArdiaShared, ArdiaSync, ArdiaBrowser, ArdiaDesign, ArdiaSyncCore",
    license: "Apache-2.0",
    url: "https://github.com/mantrakp04/ardia",
  },
];

const androidNative = (): LibraryCredit[] => credits.native.map((library) => ({ name: library.name, detail: library.artifacts.join(", "), license: library.license, url: library.url }));

export function libraryCredits(platform: "ios" | "android" | string): LibraryCredit[] {
  const native = platform === "ios" ? IPHONE_NATIVE_CREDITS : androidNative();
  return [...native, ...credits.packages.map((pkg) => ({ name: pkg.name, detail: pkg.version, license: pkg.license, url: pkg.url }))];
}
