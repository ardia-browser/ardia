export type AppStateSteps = {
  becameActive: () => void;
  resignActive: () => void;
  reportShownPage: () => void;
  rememberLaunchLook: () => void;
};

export function appStateChanged(next: string, steps: AppStateSteps) {
  if (next === "active") {
    steps.becameActive();
    steps.reportShownPage();
    return;
  }
  steps.resignActive();
  steps.reportShownPage();
  steps.rememberLaunchLook();
}
