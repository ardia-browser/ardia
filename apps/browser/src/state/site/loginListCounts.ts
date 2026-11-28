import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { onApplePasswordsSaveCounted, onLoginListCounted } from "../../platform/applePasswords";
import { nativeConsent } from "../telemetry/nativeConsent";
import { noteApplePasswordsSave, noteLoginList } from "../telemetry/passwordManagerCounts";

let listening = false;

export function startLoginListCounts() {
  if (listening || !PLATFORM_FEATURES.systemPasswordManagers) return;
  listening = true;
  onLoginListCounted((count) => noteLoginList(count.name, count.engine, nativeConsent(count), count.kind));
  onApplePasswordsSaveCounted((count) => noteApplePasswordsSave(count.name, count.engine, nativeConsent(count), count.kind));
}
