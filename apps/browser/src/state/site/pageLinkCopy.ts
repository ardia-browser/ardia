import { cleanUrlReport } from "@ardia/core";
import { onWebKitCopyAddress, writeCopiedWebKitAddress } from "../../platform/webkit";
import type { ConsentToken } from "../telemetry/consentPeriod";
import { nativeConsent } from "../telemetry/nativeConsent";
import { noteWebKitMenuLinkCopied } from "../telemetry/urlCopies";

export async function copyLinkFromPageMenu(address: unknown, request: unknown, consent: ConsentToken | null): Promise<boolean> {
  if (typeof address !== "string" || !address || typeof request !== "number" || !Number.isInteger(request)) return false;
  const { url, removedTracker } = cleanUrlReport(address);
  const written = (await writeCopiedWebKitAddress(request, url).catch(() => false)) === true;
  if (written) noteWebKitMenuLinkCopied(removedTracker, consent);
  return written;
}

export const startPageLinkCopies = () => onWebKitCopyAddress((copy) => void copyLinkFromPageMenu(copy.url, copy.request, nativeConsent(copy)));
