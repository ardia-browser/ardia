import type { ExternalAppAllowance, PermissionRequest, PermissionResult } from "../../permissions";
import type { Profile } from "../wire";

export type PermissionsCalls = {
  "permissions.resolve": [{ id: string; result: PermissionResult; remember: boolean }, null];
  "permissions.resolveExternalApp": [{ id: string; open: boolean; remember: boolean }, null];
  "permissions.externalAppAllowances": [Profile, ExternalAppAllowance[]];
  "permissions.removeExternalAppAllowance": [Profile & { origin: string; scheme: string }, null];
  "permissions.devExternalLaunches": [{}, Record<string, unknown>[]];
};

export type PermissionsEvents = {
  "permissions.requested": PermissionRequest;
  "permissions.dismissed": { id: string };
};
