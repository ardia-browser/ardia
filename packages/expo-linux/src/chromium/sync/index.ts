import { KIT_PDF_NAME, KIT_TEXT_NAME, kitBytes, kitPreview, qrDataUrl } from "../../../../../apps/browser/linux/src/services/sync/kit";
import { base64 } from "../../../../../apps/browser/linux/src/services/sync/png";
import { callMain, callMainSync } from "../../bridge";

type WordsPurpose = "show" | "save" | "copy";

const SYNC = "ArdiaSync";

const deviceName = () => callMainSync<string>(SYNC, "deviceName") || "This computer";
const words = (purpose: WordsPurpose) => callMain<string[] | null>(SYNC, "recoveryWords", purpose);

async function qrCode(): Promise<string | null> {
  const disclosed = await words("show");
  return disclosed ? qrDataUrl(disclosed) : null;
}

async function recoveryKitPreview(width: number): Promise<string> {
  return kitPreview(Number(width) || 168, new Date(), deviceName());
}

async function saveRecoveryKit(format: "pdf" | "text"): Promise<string | null> {
  const text = format === "text";
  const path = await callMain<string | null>("ArdiaDialogs", "saveFile", text ? KIT_TEXT_NAME : KIT_PDF_NAME, text ? "txt" : "pdf", text ? "Text" : "PDF", "");
  if (!path) return null;
  const disclosed = await words("save");
  if (!disclosed) return null;
  const saved = await callMain<boolean>(SYNC, "saveKitFile", path, base64(kitBytes(disclosed, text ? "text" : "pdf", deviceName())));
  return saved ? path : null;
}

async function copyRecoveryKit(): Promise<boolean | null> {
  const disclosed = await words("copy");
  if (!disclosed) return null;
  return (await callMain<boolean>(SYNC, "copyKitFile", KIT_PDF_NAME, base64(kitBytes(disclosed, "pdf", deviceName())))) ?? null;
}

const chooseFolder = async (current: string | null) => (await callMain<string | null>("ArdiaDialogs", "pickFolder", current, "Use Folder")) ?? null;

export const syncModules: Record<string, Record<string, unknown>> = {
  ArdiaSync: {
    chooseFolder,
    qrCode,
    recoveryKitPreview,
    saveRecoveryKit,
    copyRecoveryKit,
    shareRecoveryKit: async () => false,
  },
};
