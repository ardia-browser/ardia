import { systemInfo } from "../../platform/app";
import { PLATFORM_TERMS } from "../../lib/platformTerms";

export function thisDeviceDetails(): { v?: string; os?: string } {
  try {
    const info = systemInfo();
    return { ...(info.appVersion ? { v: info.appVersion } : {}), ...(info.osVersion ? { os: `${PLATFORM_TERMS.os} ${info.osVersion}` } : {}) };
  } catch {
    return {};
  }
}
