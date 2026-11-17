import { create } from "zustand";
import { pages, type SitePermissionGrant, type SitePermissionKind } from "../../platform/pages";
import { countUsage } from "../telemetry/telemetry";

type SitePermissionsState = { listed: boolean; grants: SitePermissionGrant[] };

export const useSitePermissions = create<SitePermissionsState>()(() => ({ listed: false, grants: [] }));

export async function refreshSitePermissions() {
  if (!pages.listsSitePermissions()) return;
  const grants = await pages.sitePermissions();
  useSitePermissions.setState({ listed: true, grants });
}

export async function revokeSiteAccess(origin: string, permission?: SitePermissionKind) {
  const revoked = await pages.revokeSitePermission(origin, permission);
  if (revoked) countUsage("site_permissions_revoked");
  await refreshSitePermissions();
}
