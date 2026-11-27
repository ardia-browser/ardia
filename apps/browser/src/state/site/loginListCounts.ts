import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { onApplePasswordsSaveCounted, onLoginListCounted } from "../../platform/applePasswords";
import { nativeConsent } from "../telemetry/nativeConsent";
import { noteApplePasswordsSave, noteLoginList } from "../telemetry/passwordManagerCounts";

let listening = false;

export function startLoginListCounts() {
  if (listening || !PLATFORM_FEATURES.systemPasswordManagers) return;
  listening = true;
  onLoginListCounted((count) => noteLoginList(count.name, nativeConsent(count)));
  onApplePasswordsSaveCounted((count) => noteApplePasswordsSave(count.name, nativeConsent(count)));
}
