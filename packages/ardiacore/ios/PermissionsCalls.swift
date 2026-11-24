import ExpoModulesCore

func permissionsCallTable(resolve resolveHandler: @escaping CallHandler, resolveExternalApp resolveExternalAppHandler: @escaping CallHandler, externalAppAllowances externalAppAllowancesHandler: @escaping CallHandler, removeExternalAppAllowance removeExternalAppAllowanceHandler: @escaping CallHandler, devExternalLaunches devExternalLaunchesHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "permissions", handlers: [
    "resolve": resolveHandler,
    "resolveExternalApp": resolveExternalAppHandler,
    "externalAppAllowances": externalAppAllowancesHandler,
    "removeExternalAppAllowance": removeExternalAppAllowanceHandler,
    "devExternalLaunches": devExternalLaunchesHandler,
  ])
}
