import { counted, onConsentPeriodChange, type ConsentToken } from "./choice";

const none = () => ({ refusals: 0, access: 0, createMediaKeys: 0, licence: 0, keystatus: 0, listedSites: 0, webKitSites: 0 });

let tally = none();

onConsentPeriodChange(() => (tally = none()));

const REFUSAL_STAGES = ["access", "createMediaKeys", "licence", "keystatus"] as const;
type RefusalStage = (typeof REFUSAL_STAGES)[number];

const isRefusalStage = (stage: unknown): stage is RefusalStage => REFUSAL_STAGES.includes(stage as RefusalStage);

type RefusalSite = { listed: boolean; routedToWebKit: boolean };

export function noteProtectedVideoRefusal({ stage }: { keySystem: string; stage?: string }, consent: ConsentToken | null, site?: RefusalSite) {
  counted(consent, () => {
    tally.refusals++;
    if (isRefusalStage(stage)) tally[stage]++;
    if (site?.listed) tally.listedSites++;
    if (site?.routedToWebKit) tally.webKitSites++;
  });
}

export function takeProtectedVideoCounts() {
  const taken = tally;
  tally = none();
  return {
    drm_refusals: taken.refusals,
    drm_refusals_access: taken.access,
    drm_refusals_create_keys: taken.createMediaKeys,
    drm_refusals_licence: taken.licence,
    drm_refusals_keystatus: taken.keystatus,
    drm_refusals_listed_sites: taken.listedSites,
    drm_refusals_webkit_sites: taken.webKitSites,
  };
}
