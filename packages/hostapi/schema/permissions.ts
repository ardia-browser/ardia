import { defineDomain } from "../define.ts";

export const permissions = defineDomain({
  kind: "engine",
  imports: {
    "../wire": ["Profile"],
    "../../permissions": ["ExternalAppAllowance", "PermissionRequest", "PermissionResult"],
  },
  calls: {
    resolve: {
      args: "{ id: string; result: PermissionResult; remember: boolean }",
      result: "null",
      desktop: "custom",
      mac: "custom",
      windows: "absent",
    },
    resolveExternalApp: {
      args: "{ id: string; open: boolean; remember: boolean }",
      result: "null",
      desktop: "custom",
      mac: "custom",
      windows: "custom",
    },
    externalAppAllowances: {
      args: "Profile",
      result: "ExternalAppAllowance[]",
      service: "ac_external_apps_allowances",
      desktop: "route",
      routeField: "allowances",
      mac: "custom",
      windows: "custom",
    },
    removeExternalAppAllowance: {
      args: "Profile & { origin: string; scheme: string }",
      result: "null",
      service: "ac_external_apps_remove",
      desktop: "route",
      routeField: "null",
      mac: "custom",
      windows: "custom",
    },
    devExternalLaunches: {
      args: "{}",
      result: "Record<string, unknown>[]",
      desktop: "absent",
      mac: "custom",
      windows: "absent",
    },
  },
  events: {
    requested: {
      payload: "PermissionRequest",
      desktop: "custom",
      mac: "custom",
      windows: "absent",
    },
    dismissed: {
      payload: "{ id: string }",
      desktop: "custom",
      mac: "custom",
      windows: "absent",
    },
  },
});
