import type { HydrateData } from "../../browser/src/state/browser/store";
import { isPinChoices, stampedPinChoices } from "../../browser/src/state/pins/pinChoices";

const needsRepair = (session: HydrateData) => session.pinChoices !== undefined && !isPinChoices(session.pinChoices);

export const withPinChoiceStamps = (session: HydrateData): HydrateData =>
  needsRepair(session) ? { ...session, pinChoices: stampedPinChoices(session.pinChoices) } : session;

export const withPinChoicesOnDisk = (shaped: HydrateData, disk: HydrateData): HydrateData =>
  needsRepair(disk) ? { ...shaped, pinChoices: disk.pinChoices } : shaped;
