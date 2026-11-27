export const SITES_TRANSPORT_ENABLED = false;

export const SITES_TRANSPORT_OFF_REASON =
  "Ardia's site sign-in is off in this version: it turns back on once the engine refuses a redirect to another site before following it.";

let enabledForTests = false;

export const sitesTransportOn = () => SITES_TRANSPORT_ENABLED || enabledForTests;

export const enableSitesTransportForTests = (on: boolean) => void (enabledForTests = on);
