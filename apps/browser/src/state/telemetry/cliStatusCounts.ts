import type { CliControlStatus } from "../../platform/cli";
import type { ConsentToken } from "./choice";
import { noteWindowlessPages } from "./cliCounts";
import { notePushMessaging } from "./pushMessagingCounts";
import { noteDragsEnded } from "./stuckDrags";

export function noteCliControlStatus(status: CliControlStatus, consent: ConsentToken | null) {
  noteDragsEnded(status.dragsEnded, consent);
  noteWindowlessPages(status.windowlessPages, consent);
  notePushMessaging(status.pushMessaging, consent);
}
