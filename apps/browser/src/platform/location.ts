import { nativeModule, type LocationPermission } from "@ardia/shell";
import { t } from "../lib/uiLanguage";


export type { LocationPermission };

const Location = nativeModule(t(`ArdiaLocation`));

export const locationPermission = () => Location.locationPermission();
export const requestLocationPermission = () => Location.requestLocationPermission();
export const openLocationSettings = () => Location.openLocationSettings();
