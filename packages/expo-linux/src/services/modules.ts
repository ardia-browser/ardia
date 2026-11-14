import { callMain } from "../bridge";

const KIT_PDF_NAME = "Ardia Recovery Kit.pdf";
const KIT_TEXT_NAME = "Ardia Recovery Kit.txt";

const pickFolder = (current: string | null) => callMain<string | null>("ArdiaDialogs", "pickFolder", current, "Use Folder");

async function saveRecoveryKit(format: "pdf" | "text"): Promise<string | null> {
  const text = format === "text";
  const path = await callMain<string | null>("ArdiaDialogs", "saveFile", text ? KIT_TEXT_NAME : KIT_PDF_NAME, text ? "txt" : "pdf", text ? "Text" : "PDF", "");
  if (!path) return null;
  return (await callMain<string | null>("ArdiaSync", "writeRecoveryKit", path, format)) ?? null;
}

export const serviceModules: Record<string, Record<string, unknown>> = {
  ArdiaSync: {
    chooseFolder: async (current: string | null) => (await pickFolder(current)) ?? null,
    saveRecoveryKit,
  },
};
