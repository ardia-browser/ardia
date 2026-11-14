import { loadModule, type LanguageIdentifier } from "cld3-asm";

const MIN_PROBABILITY = 0.5;
const RENAMED: Record<string, string> = { iw: "he", fil: "tl", no: "nb", jw: "jv" };
const TRADITIONAL = "這個們說來時會對為國學與後開發經還現種點長車門問間東見話題實際關係電體歷無";
const SIMPLIFIED = "这个们说来时会对为国学与后开发经还现种点长车门问间东见话题实际关系电体历无";

let identifier: Promise<LanguageIdentifier> | null = null;

function chineseScript(text: string): string {
  let traditional = 0;
  let simplified = 0;
  for (const char of text) {
    if (TRADITIONAL.includes(char)) traditional++;
    else if (SIMPLIFIED.includes(char)) simplified++;
  }
  return traditional > simplified ? "zh-Hant" : "zh-Hans";
}

export async function detectLanguage(text: string): Promise<string | null> {
  identifier ??= loadModule().then((factory) => factory.create(0, 1000));
  const found = (await identifier).findLanguage(text);
  const language = found.language;
  if (found.probability < MIN_PROBABILITY || language === "und" || language.endsWith("-Latn")) return null;
  if (language === "zh") return chineseScript(text);
  return RENAMED[language] ?? language;
}
