import type { ChoiceItem } from "../app/menuChoice";
import { menuSections } from "../app/menuSections";

type TranslateMenuState = {
  translated: boolean;
  target: string;
  languages: { id: string; name: string; current: boolean }[];
  neverTranslate: boolean | null;
};

type TranslateMenuItem = ChoiceItem<{ language: string }, "original" | "translate" | "choose" | "never">;

export function translateMenuItems({ translated, target, languages, neverTranslate }: TranslateMenuState): TranslateMenuItem[] {
  return menuSections<TranslateMenuItem>(
    [
      translated ? { id: "original" as const, title: "Show Original", symbol: "arrow.uturn.backward" } : { id: "translate" as const, title: `Translate to ${target}`, symbol: "translate" },
      languages.length > 0 && {
        id: "choose" as const,
        title: "Choose Another Language",
        symbol: "globe",
        children: languages.map((l) => ({ value: { language: l.id }, title: l.name, checked: l.current })),
      },
    ],
    [neverTranslate !== null && { id: "never" as const, title: "Never Translate This Site", checked: neverTranslate }],
  );
}

type TranslatePageMenuState = { status: "idle" | "translating" | "translated"; source: string | null };
export type TranslatePageMenu = "translatePage" | "showOriginal" | null;

export const translatePageMenu = (state: TranslatePageMenuState | undefined): TranslatePageMenu => (!state ? null : state.status !== "idle" ? "showOriginal" : state.source ? "translatePage" : null);

export function translatePageMenuItems(menu: TranslatePageMenu, targetName: string): { id: "translatePage" | "showOriginal"; title: string }[] {
  if (menu === "showOriginal") return [{ id: "showOriginal", title: "Show Original" }];
  return menu === "translatePage" ? [{ id: "translatePage", title: `Translate to ${targetName}` }] : [];
}
