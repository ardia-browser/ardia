import { isDefaultBrowser, setAsDefaultBrowser, systemInfo } from "../../platform/app";
import { readDocument, saveDocument } from "../../platform/documents";
import { maybeStartOnboarding, onboardingCompletedAt, useOnboarding } from "../onboarding/onboarding";
import { trackAppVersion } from "../releaseNotes/releaseNotes";
import { afterFirstWindow } from "../../lib/afterFirstWindow";
import { offerDefaultBrowserAgain } from "../onboarding/defaultBrowserOffer";
import { openReleaseNotesAfterUpdate } from "../releaseNotes/releaseNotesPage";
import { startNotificationResponses } from "./notificationResponses";
import { startHandoff } from "./handoff";
import { startScripting } from "./scripting";

export function startAppIntegration() {
  startNotificationResponses();
  startHandoff();
  startScripting();
  const updated = trackAppVersion();
  maybeStartOnboarding();
  if (updated) openReleaseNotesAfterUpdate();
  afterFirstWindow(() => {
    void offerDefaultBrowserAgain({
      read: readDocument,
      save: saveDocument,
      testInstance: systemInfo().isolatedInstance !== false,
      onboarding: !onboardingCompletedAt() || useOnboarding.getState().windowId !== null,
      isDefault: isDefaultBrowser,
      setDefault: setAsDefaultBrowser }).catch((error) => console.warn("[defaultBrowserOffer]", error));
  });
}
