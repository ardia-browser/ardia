import { orWarn, passwordFailure } from "../../lib/fallback";
import { capture, type ConsentToken } from "./client";

type PasswordImportSource = "browser" | "csv";
export type PasswordSaveResult = "saved" | "refused" | "failed";

export function passwordImportTally(source: PasswordImportSource, consent: ConsentToken | null) {
  const counts = { tried: 0, saved: 0, refused: 0, not_landed: 0, other: 0 };
  const warn = orWarn(false, source === "csv" ? "csv import" : "browser import");
  const settle = async (save: Promise<boolean>): Promise<PasswordSaveResult> => {
    counts.tried++;
    try {
      const saved = await save;
      if (saved) counts.saved++;
      else counts.other++;
      return saved ? "saved" : "failed";
    } catch (error) {
      const failure = passwordFailure(error);
      if (failure === "refused-or-already-saved") counts.refused++;
      else if (failure === "not-landed-in-time") counts.not_landed++;
      else counts.other++;
      warn(error);
      return failure === "refused-or-already-saved" ? "refused" : "failed";
    }
  };
  return {
    settle,
    async attempt(save: Promise<boolean>): Promise<boolean> {
      return (await settle(save)) === "saved";
    },
    done() {
      if (counts.tried) capture("password_import", { source, ...counts }, consent);
    },
  };
}
