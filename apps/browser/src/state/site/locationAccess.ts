import { confirm } from "../../platform/dialogs";
import { locationPermission, openLocationSettings, requestLocationPermission, type LocationPermission } from "../../platform/location";
import { capture, consentToken, type ConsentToken } from "../telemetry/client";

let toldAboutSettings = false;

const noteLocationAccess = (outcome: "granted" | "denied_by_user" | "denied_by_system" | "error", consent: ConsentToken | null) => capture("location_access", { outcome }, consent);

const blockedBySystem = (status: LocationPermission) => status === "denied" || status === "restricted" || status === "servicesOff";

export async function ensureLocationPermission(windowId?: string): Promise<boolean> {
  const consent = consentToken();
  let status: LocationPermission;
  try {
    status = await locationPermission();
    if (status === "notDetermined") {
      status = await requestLocationPermission();
      if (status === "granted") noteLocationAccess("granted", consent);
      else if (blockedBySystem(status)) noteLocationAccess("denied_by_user", consent);
      else noteLocationAccess("error", consent);
      return status === "granted";
    }
  } catch {
    noteLocationAccess("error", consent);
    return false;
  }
  if (status === "granted") {
    noteLocationAccess("granted", consent);
    return true;
  }
  noteLocationAccess("denied_by_system", consent);
  if (toldAboutSettings) return false;
  toldAboutSettings = true;
  const off = status === "servicesOff";
  const { confirmed } = await confirm({
    title: off ? "Location Services Are Off" : "Ardia Needs Location Permission",
    message: off
      ? "Turn on Location Services in System Settings so websites you allow can use your location."
      : "You need to open System Settings to give Ardia permission to use your location.",
    confirmTitle: "Open System Settings",
    cancelTitle: "Not Now",
    windowId,
  });
  if (confirmed) void openLocationSettings();
  return false;
}
