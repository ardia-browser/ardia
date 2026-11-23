import type { PluginManifest } from "../../lib/pluginManifest";
import { PLATFORM_TERMS } from "../../lib/platformTerms";

export type RemoveWords = { row: string; alert: string };

export function removeWords(m: Pick<PluginManifest, "programs" | "contributes"> | null | undefined, official: boolean): RemoveWords {
  const trash = PLATFORM_TERMS.trash;
  if (!official) return { row: `Moves its folder to the ${trash} and deletes its data.`, alert: `Its folder moves to the ${trash}, and its data and its panel's website data are deleted.` };
  const provider = m?.contributes.credentialProvider ?? null;
  if (provider)
    return {
      row: "Removes its download, signs it out and deletes its saved copy of your logins.",
      alert: `Its download is removed, it's signed out and its saved copy of your logins is deleted. Your logins stay in ${provider.title}.`,
    };
  if (m?.programs.length)
    return {
      row: "Removes its download and its commands on your PATH. Its data stays.",
      alert: "Its download and its commands on your PATH are removed. Its data and secrets stay, so installing it again picks up where you left off.",
    };
  return { row: "Removes its download. Its data stays.", alert: "Its download is removed. Its data and secrets stay, so installing it again picks up where you left off." };
}
