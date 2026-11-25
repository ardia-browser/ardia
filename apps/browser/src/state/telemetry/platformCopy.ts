import { copyWords } from "./copyWords";
import { addItems, rewordInPlace, type WhatsSentGroup } from "./platformWording";

export function platformCopy(copy: { WHATS_SENT: WhatsSentGroup[] } & Readonly<Record<string, object>>, added: Readonly<Record<string, readonly string[]>>) {
  addItems(copy.WHATS_SENT, added);
  rewordInPlace(copy, copyWords);
}
