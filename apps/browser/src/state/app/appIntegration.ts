import { isDefaultBrowser, systemInfo } from "../../platform/app";
import { setAsDefaultBrowser } from "./appSettings";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { readDocument, saveDocument } from "../../platform/documents";
import { maybeStartOnboarding, onboardingCompletedAt, useOnboarding } from "../onboarding/onboarding";
import { trackAppVersion } from "../releaseNotes/releaseNotes";
import { afterFirstWindow } from "../../lib/afterFirstWindow";
import { offerDefaultBrowserAgain } from "../onboarding/defaultBrowserOffer";
import { openReleaseNotesAfterUpdate } from "../releaseNotes/releaseNotesPage";
import { startNotificationResponses } from "./notificationResponses";
import { startHandoff } from "./handoff";
import { startScripting } from "./scripting";
import { noteReleaseNotesHeldForFirstRun } from "../telemetry/firstRunCounts";

export function startAppIntegration() {
  startNotificationResponses();
  startHandoff();
  startScripting();
  const updated = trackAppVersion();
  const firstRun = maybeStartOnboarding();
  if (updated && firstRun) noteReleaseNotesHeldForFirstRun();
  if (updated && !firstRun) openReleaseNotesAfterUpdate();
  afterFirstWindow(() => {
    if (!PLATFORM_FEATURES.setsDefaultBrowser) return;
    void offerDefaultBrowserAgain({
      read: readDocument,
      save: saveDocument,
      testInstance: systemInfo().isolatedInstance !== false,
      onboarding: !onboardingCompletedAt() || useOnboarding.getState().windowId !== null,
      isDefault: isDefaultBrowser,
      setDefault: setAsDefaultBrowser }).catch((error) => console.warn("[defaultBrowserOffer]", error));
  });
}
